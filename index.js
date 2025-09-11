require('dotenv').config();
const { Telegraf } = require('telegraf');
const { MongoClient } = require('mongodb');
const express = require('express');
const crypto = require('crypto');
const cron = require('node-cron');
const CryptoJS = require('crypto-js');

// Загружаем администраторов из .env
const ADMINS = process.env.ADMINS ? process.env.ADMINS.split(',').map(id => id.trim()) : [];

// Проверка администратора
function isAdmin(userId) {
    return ADMINS.includes(userId.toString());
}

// Инициализация приложения
const app = express();
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

// Middleware для обработки данных
app.use(express.urlencoded({ extended: true }));
app.use(express.json({ 
    verify: (req, res, buf) => {
        try {
            JSON.parse(buf);
        } catch (e) {
            // Игнорируем ошибки парсинга для не-JSON запросов
            return true;
        }
    }
}));

// Конфигурация Robokassa
const ROBOKASSA_LOGIN = process.env.ROBOKASSA_LOGIN;
const ROBOKASSA_PASS1 = process.env.ROBOKASSA_PASS1;
const ROBOKASSA_PASS2 = process.env.ROBOKASSA_PASS2;
const ROBOKASSA_TEST_MODE = process.env.ROBOKASSA_TEST_MODE === 'true';

// Подключение к MongoDB
let db;
let paymentsCollection;
let subscriptionsCollection;

// Объект для хранения состояний пользователей
const userStates = {};

async function activateSubscription(userId, paymentInfo, paymentMethod = 'robokassa') {
    const expiresAt = new Date();
    expiresAt.setMonth(expiresAt.getMonth() + 1);

    const subscriptionData = {
        userId,
        status: 'active',
        currentPeriodEnd: expiresAt,
        autoRenew: true,
        lastPaymentId: paymentInfo.InvId,
        paymentMethod: paymentMethod,
        amount: paymentInfo.OutSum,
        updatedAt: new Date(),
        paymentData: paymentInfo
    };

    await subscriptionsCollection.updateOne(
        { userId },
        { $set: subscriptionData },
        { upsert: true }
    );
}

async function connectToDatabase() {
    try {
        const client = new MongoClient(process.env.MONGODB_URI);
        await client.connect();
        console.log('✅ Успешно подключено к MongoDB');
        
        db = client.db();
        paymentsCollection = db.collection('payments');
        subscriptionsCollection = db.collection('subscriptions');

        // индексы
        await subscriptionsCollection.createIndex({ userId: 1 }, { unique: true });
        await subscriptionsCollection.createIndex({ status: 1 });
        await subscriptionsCollection.createIndex({ currentPeriodEnd: 1 });
        await paymentsCollection.createIndex({ userId: 1 });
        await paymentsCollection.createIndex({ robokassaId: 1 });
        await paymentsCollection.createIndex({ status: 1 });
        await paymentsCollection.createIndex({ createdAt: 1 });
        
    } catch (error) {
        console.error('❌ Ошибка подключения к MongoDB:', error);
        process.exit(1);
    }
}

// Функции для работы с базой данных
async function createPayment(paymentData) {
    const result = await paymentsCollection.insertOne({
        ...paymentData,
        createdAt: new Date(),
        updatedAt: new Date()
    });
    return result.insertedId;
}

async function getPayment(query) {
    return await paymentsCollection.findOne(query);
}

async function updatePayment(query, updateData) {
    return await paymentsCollection.updateOne(query, {
        $set: { ...updateData, updatedAt: new Date() }
    });
}

// Функция для проверки, является ли пользователь участником чата
async function isUserInChat(userId) {
    try {
        const chatId = process.env.CHANNEL_ID;
        const member = await bot.telegram.getChatMember(chatId, userId);
        
        // Если пользователь является владельцем, администратором или участником
        return ['creator', 'administrator', 'member', 'restricted'].includes(member.status);
    } catch (error) {
        // Если пользователь не найден в чате или нет доступа
        if (error.response && error.response.description.includes('user not found')) {
            return false;
        }
        console.error('Ошибка при проверке участника чата:', error);
        return false;
    }
}

// Функция для проверки, является ли пользователь владельцем чата
async function isChatOwner(userId) {
    try {
        const chatId = process.env.CHANNEL_ID;
        const member = await bot.telegram.getChatMember(chatId, userId);
        return member.status === 'creator';
    } catch (error) {
        console.error('Ошибка при проверке владельца чата:', error);
        return false;
    }
}

async function addUserToChat(userId) {
    try {
        const chatId = process.env.CHANNEL_ID;
        
        // Проверяем, не является ли пользователь уже участником
        try {
            const member = await bot.telegram.getChatMember(chatId, userId);
            if (['creator', 'administrator', 'member'].includes(member.status)) {
                return { success: true, alreadyMember: true };
            }
        } catch (error) {
            // Пользователь не в чате, продолжаем
        }

        // Создаем инвайт-ссылку
        const inviteLink = await bot.telegram.createChatInviteLink(chatId, {
            member_limit: 1,
            creates_join_request: false
        });

        return { 
            success: true, 
            link: inviteLink.invite_link 
        };
    } catch (error) {
        console.error('Error adding user to chat:', error);
        return { success: false, error: error.message };
    }
}

// Функция для проверки доступа к чату
async function checkChatAccess() {
    try {
        const chatId = process.env.CHANNEL_ID;

        // инициализируем информацию о боте, если еще нет
        if (!bot.botInfo) {
            bot.botInfo = await bot.telegram.getMe();
        }

        const chat = await bot.telegram.getChat(chatId);
        console.log('📋 Информация о чате:', {
            id: chat.id,
            type: chat.type,
            title: chat.title
        });

        // Проверяем права бота
        const member = await bot.telegram.getChatMember(chatId, bot.botInfo.id);
        console.log('👮 Права бота:', member.status);

        return true;
    } catch (error) {
        console.error('❌ Чат недоступен:', error);
        return false;
    }
}

// Генерация подписи для Robokassa
function generateRobokassaSignature(OutSum, InvId, customParams = {}) {
    // Формируем строку для подписи: MerchantLogin:OutSum:InvId:Пароль1
    let signatureString = `${ROBOKASSA_LOGIN}:${OutSum}:${InvId}:${ROBOKASSA_PASS1}`;
    
    // Добавляем пользовательские параметры, если они есть
    if (Object.keys(customParams).length > 0) {
        const paramsString = Object.entries(customParams)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, value]) => `${key}=${value}`)
            .join(':');
        signatureString += `:${paramsString}`;
    }
    
    // Создаем MD5 хеш
    return crypto.createHash('md5').update(signatureString).digest('hex');
}

function verifyRobokassaSignature(OutSum, InvId, SignatureValue, customParams = {}) {
    // Проверяем наличие всех обязательных параметров
    if (!OutSum || !InvId || !SignatureValue) {
        console.error('Missing required parameters for signature verification', {
            OutSum,
            InvId,
            SignatureValue
        });
        return false;
    }

    // Формируем базовую строку: OutSum:InvId:Пароль2
    let signatureString = `${OutSum}:${InvId}:${ROBOKASSA_PASS2}`;
    
    // Копируем и фильтруем параметры
    const filteredParams = { ...customParams };
    delete filteredParams.crc;
    delete filteredParams.SignatureValue;
    
    // Сортируем параметры по алфавиту
    const sortedKeys = Object.keys(filteredParams).sort();
    
    // Добавляем параметры к строке подписи
    if (sortedKeys.length > 0) {
        const paramsString = sortedKeys.map(key => `${key}=${filteredParams[key]}`).join(':');
        signatureString += `:${paramsString}`;
    }
    
    // Создаем MD5 хеш
    const mySignature = crypto.createHash('md5').update(signatureString).digest('hex');
    
    console.log('Generated signature string:', signatureString);
    console.log('My signature:', mySignature);
    console.log('Received signature:', SignatureValue);
    
    return mySignature.toLowerCase() === SignatureValue.toLowerCase();
}

// Команда /start с выбором способа оплаты
bot.command('start', async (ctx) => {
    try {
        const userId = ctx.from.id;
        
        if (isAdmin(userId)) {
            return ctx.reply('⚙️ Добро пожаловать в панель администратора!', {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🚀 Войти в админку', callback_data: 'admin_panel' }]
                    ]
                }
            });
        }

        const isMember = await isUserInChat(userId);
        if (isMember) {
            return ctx.replyWithMarkdown(`
✅ *Вы уже имеете доступ к нашему сообществу!*

Если у вас возникли проблемы с доступом, обратитесь в техподдержку.
            `, {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '📌 Моя подписка', callback_data: 'mysub' }],
                        [{ 
                            text: '💬 Техподдержка', 
                            url: 'https://t.me/golube123' 
                        }]
                    ]
                }
            });
        }
        
        ctx.replyWithMarkdown(`
🎉 *Добро пожаловать в наше эксклюзивное сообщество!*

Для доступа к закрытому контенту оформите подписку на 1 месяц.

💎 *Преимущества подписки:*
✔️ Доступ к эксклюзивным материалам
✔️ Закрытые обсуждения
✔️ Персональные уведомления
✔️ Поддержка создателей

Стоимость подписки: *100 рублей*

Выберите способ оплаты

продолжая вы соглашаетесь с офертой:
        `, {
            reply_markup: {
                inline_keyboard: [
                    [{ 
                        text: '💳 Банковская карта (Robokassa)', 
                        callback_data: 'choose_payment:robokassa' 
                    }],
                    [{ 
                        text: '📃 Оферта',
                        callback_data: 'show_oferta' 
                    }],
                    [{ 
                        text: '❓ Помощь', 
                        url: 'https://t.me/golube123' 
                    }]
                ]
            }
        });

    } catch (error) {
        console.error('Ошибка в команде /start:', error);
        ctx.reply('⚠️ Произошла ошибка. Попробуйте позже.');
    }
});

// Выбор способа оплаты
bot.action(/choose_payment:(.+)/, async (ctx) => {
    const paymentMethod = ctx.match[1];
    const userId = ctx.from.id;
    const paymentId = `${paymentMethod}_${Date.now()}_${userId}`;

    try {
        const isMember = await isUserInChat(userId);
        if (isMember) {
            await ctx.editMessageText(`
✅ *У вас уже есть доступ к сообществу!*

Оплата не требуется. Если возникли проблемы с доступом, обратитесь в техподдержку.
            `, { parse_mode: 'Markdown' });
            return ctx.answerCbQuery();
        }

        await createPayment({
            _id: paymentId,
            userId: userId,
            paymentMethod: paymentMethod,
            status: 'pending',
            username: ctx.from.username || 'нет username',
            firstName: ctx.from.first_name || '',
            lastName: ctx.from.last_name || ''
        });

        if (paymentMethod === 'robokassa') {
            await ctx.editMessageText(`
🔒 *Оплата банковской картой через Robokassa*

Вы оформляете подписку на наше сообщество:
▫️ Сумма: *100 рублей*
▫️ Срок: *1 месяц*
▫️ Автопродление: *Недоступно*

Для продолжения подтвердите платеж:
            `, {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ 
                            text: '✅ Подтвердить оплату', 
                            callback_data: `confirm_pay:${paymentId}` 
                        }],
                        [{ 
                            text: '❌ Отменить', 
                            callback_data: `cancel_pay:${paymentId}` 
                        }]
                    ]
                }
            });
        }

        ctx.answerCbQuery();
    } catch (error) {
        console.error('Ошибка в choose_payment:', error);
        ctx.answerCbQuery('⚠️ Произошла ошибка');
    }
});

// Обработка кнопки "Оплатить"
bot.action(/confirm_pay:(.+)/, async (ctx) => {
    const paymentId = ctx.match[1];
    const userId = ctx.from.id;

    try {
        // Проверяем, есть ли уже доступ
        const isMember = await isUserInChat(userId);
        if (isMember) {
            await ctx.editMessageText(`
✅ *У вас уже есть доступ к сообществу!*

Оплата не требуется. Если возникли проблемы с доступом, обратитесь в техподдержку.
            `, { parse_mode: 'Markdown' });
            return ctx.answerCbQuery();
        }

        const paymentData = await getPayment({ _id: paymentId, userId: userId });
        if (!paymentData) {
            return ctx.answerCbQuery('⚠️ Платеж не найден');
        }

        await ctx.editMessageText('🔄 *Создаем платеж...*', { 
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [] }
        });

        // Генерируем подпись для Robokassa
        const OutSum = '100.00';
        const InvId = paymentId;
        const description = `Подписка на сообщество для пользователя ${userId}`;
        
        const signature = generateRobokassaSignature(OutSum, InvId, {
            user_id: userId,
            description: encodeURIComponent(description)
        });

        // Формируем URL для оплаты
        const subscriptionUrl = `https://auth.robokassa.ru/RecurringSubscriptionPage/Subscription/Subscribe?SubscriptionId=f8f609fe-3798-4ac8-97e6-0523d53f4caa`;

        await updatePayment(
            { _id: paymentId },
            { 
                robokassaId: InvId,
                status: 'waiting_for_subscription',
                paymentUrl: subscriptionUrl,
                amount: OutSum
            }
        );

        await ctx.editMessageText(`
🔗 *Перейдите на страницу оплаты*

Для завершения оплаты перейдите по ссылке ниже и следуйте инструкциям.

После успешной оплаты вы автоматически получите доступ к сообществу.
        `, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{
                        text: '🌐 Перейти к оплате',
                        url: subscriptionUrl
                    }],
                    [{
                        text: '🔄 Проверить оплату',
                        callback_data: `check_payment:${paymentId}`
                    }]
                ]
            }
        });

    } catch (error) {
        console.error('Ошибка в confirm_pay:', error);
        ctx.editMessageText('⚠️ *Ошибка при создании платежа*', { parse_mode: 'Markdown' });
    }
});

async function checkRobokassaPaymentStatus(invId) {
    try {
        const login = ROBOKASSA_LOGIN;
        const password2 = ROBOKASSA_PASS2;
        
        // Правильный метод проверки статуса
        const signature = crypto.createHash('md5')
            .update(`${login}:${invId}:${password2}`)
            .digest('hex');
        
        const url = `https://auth.robokassa.ru/Merchant/WebService/Service.asmx/OpState?MerchantLogin=${login}&InvoiceID=${invId}&Signature=${signature}`;
        
        const response = await fetch(url);
        const text = await response.text();
        
        // Парсим XML ответ
        const stateMatch = text.match(/<State\s+[^>]*code="(\d+)"/);
        return stateMatch && stateMatch[1] === '100';
    } catch (error) {
        console.error('Ошибка при проверке статуса платежа:', error);
        return false;
    }
}

// Проверка платежа
bot.action(/check_payment:(.+)/, async (ctx) => {
    const paymentId = ctx.match[1];
    const userId = ctx.from.id;

    try {
        ctx.answerCbQuery('🔍 Проверяем платеж...');
        
        const paymentData = await getPayment({ _id: paymentId, userId: userId });
        if (!paymentData) {
            throw new Error('Платеж не найден');
        }

        // Если статус еще не обновлен вебхуком, проверяем через API
        if (paymentData.status !== 'completed') {
            // Здесь должна быть функция проверки статуса через API Robokassa
            const isPaid = await checkRobokassaPaymentStatus(paymentData.robokassaId);
            
            if (isPaid) {
                // Обновляем статус вручную
                await updatePayment(
                    { _id: paymentId },
                    { status: 'completed', paidAt: new Date() }
                );
                
                // Добавляем пользователя в чат
                const result = await addUserToChat(userId);
                // ... остальная логика
            } else {
                ctx.answerCbQuery('⏳ Платеж еще не завершен', { show_alert: true });
                return;
            }
        }
        
        // ... остальная логика для завершенного платежа
    } catch (error) {
        console.error('Ошибка в check_payment:', error);
        ctx.answerCbQuery('⚠️ Ошибка при проверке платежа', { show_alert: true });
    }
});

// Отмена платежа
bot.action(/cancel_pay:(.+)/, async (ctx) => {
    const paymentId = ctx.match[1];
    const userId = ctx.from.id;

    try {
        await updatePayment(
            { _id: paymentId },
            { status: 'cancelled_by_user' }
        );

        await ctx.editMessageText(`
🗑 *Платеж отменен*

Вы можете оформить подписку в любое время, воспользовавшись командой /start

Хорошего дня! ☀️
        `, { 
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [] }
        });

        ctx.answerCbQuery();
    } catch (error) {
        console.error('Ошибка в cancel_pay:', error);
        ctx.answerCbQuery('⚠️ Ошибка при отмене платежа');
    }
});

// Вебхук для уведомлений о рекуррентных платежах Robokassa
app.post('/recurrent', async (req, res) => {
    try {
        const { OutSum, InvId, SignatureValue, SubscriptionId, ...customParams } = req.query;
        
        // Проверяем подпись
        if (!verifyRobokassaSignature(OutSum, InvId, SignatureValue, customParams)) {
            console.error('Неверная подпись уведомления от Robokassa recurrent');
            return res.status(401).send('bad sign');
        }

        // Ищем подписку в базе
        const subscriptionData = await subscriptionsCollection.findOne({ 
            robokassaSubscriptionId: SubscriptionId
        });
        
        if (!subscriptionData) {
            return res.status(404).send('Subscription not found');
        }

        const userId = subscriptionData.userId;

        // Обновляем дату окончания подписки
        const newExpiryDate = new Date();
        newExpiryDate.setMonth(newExpiryDate.getMonth() + 1);
        
        await subscriptionsCollection.updateOne(
            { userId },
            {
                $set: {
                    currentPeriodEnd: newExpiryDate,
                    lastPaymentDate: new Date(),
                    lastPaymentAmount: OutSum,
                    updatedAt: new Date()
                }
            }
        );

        // Записываем информацию о платеже
        await createPayment({
            _id: `recurring_${Date.now()}_${userId}`,
            userId: userId,
            paymentMethod: 'robokassa_recurring',
            status: 'completed',
            amount: OutSum,
            robokassaId: InvId,
            robokassaSubscriptionId: SubscriptionId,
            username: subscriptionData.username,
            firstName: subscriptionData.firstName,
            lastName: subscriptionData.lastName
        });

        res.send(`OK${InvId}`);
    } catch (error) {
        console.error('Ошибка в Robokassa recurring вебхуке:', error);
        res.status(500).send('error');
    }
});

// Обработка GET вебхука от Robokassa
app.get('/robokassa-webhook', async (req, res) => {
    try {
        console.log('GET webhook query:', req.query);
        
        // Извлекаем параметры из query string
        const OutSum = req.query.OutSum || req.query.out_summ;
        const InvId = req.query.InvId || req.query.inv_id;
        const SignatureValue = req.query.SignatureValue || req.query.crc;
        
        // Копируем все остальные параметры
        const customParams = { ...req.query };
        delete customParams.OutSum;
        delete customParams.out_summ;
        delete customParams.InvId;
        delete customParams.inv_id;
        delete customParams.SignatureValue;
        delete customParams.crc;
        
        console.log('Processing payment:', { OutSum, InvId, SignatureValue, customParams });
        
        if (!OutSum || !InvId || !SignatureValue) {
            console.error('Missing required parameters');
            return res.status(400).send('Missing parameters');
        }
        
        // Проверяем подпись
        if (!verifyRobokassaSignature(OutSum, InvId, SignatureValue, customParams)) {
            console.error('Invalid signature');
            return res.status(401).send('bad sign');
        }
        
        // Ищем платеж в базе
        const payment = await getPayment({ robokassaId: InvId });
        if (!payment) {
            console.error('Payment not found:', InvId);
            return res.status(404).send('Payment not found');
        }

        if (payment.status === 'completed') {
            console.log('Payment already processed:', InvId);
            return res.send(`OK${InvId}`);
        }

        // Обновляем статус платежа
        await updatePayment(
            { _id: payment._id },
            { status: 'completed', paidAt: new Date() }
        );

        // Активируем подписку
        await activateSubscription(payment.userId, {
            OutSum,
            InvId,
            ...customParams
        });

        // Добавляем пользователя в чат
        const result = await addUserToChat(payment.userId);
        if (result.success && result.link) {
            try {
                await bot.telegram.sendMessage(
                    payment.userId,
                    `🎉 *Оплата прошла успешно!*\n\n` +
                    `Добро пожаловать в наше сообщество! Перейдите по ссылке для доступа: ${result.link}`,
                    { parse_mode: 'Markdown' }
                );
            } catch (error) {
                console.error('Error sending message:', error);
            }
        }

        res.send(`OK${InvId}`);
    } catch (error) {
        console.error('Error in webhook:', error);
        res.status(500).send('error');
    }
});

// Обработка POST вебхука от Robokassa
app.post('/robokassa-webhook', async (req, res) => {
    try {
        console.log('POST webhook body:', req.body);
        
        // Извлекаем параметры из тела запроса
        const OutSum = req.body.OutSum || req.body.out_summ;
        const InvId = req.body.InvId || req.body.inv_id;
        const SignatureValue = req.body.SignatureValue || req.body.crc;
        
        // Копируем все остальные параметры
        const customParams = { ...req.body };
        delete customParams.OutSum;
        delete customParams.out_summ;
        delete customParams.InvId;
        delete customParams.inv_id;
        delete customParams.SignatureValue;
        delete customParams.crc;
        
        console.log('Processing payment:', { OutSum, InvId, SignatureValue, customParams });
        
        if (!OutSum || !InvId || !SignatureValue) {
            console.error('Missing required parameters');
            return res.status(400).send('Missing parameters');
        }
        
        // Проверяем подпись
        if (!verifyRobokassaSignature(OutSum, InvId, SignatureValue, customParams)) {
            console.error('Invalid signature');
            return res.status(401).send('bad sign');
        }
        
        // Ищем платеж в базе
        const payment = await getPayment({ robokassaId: InvId });
        if (!payment) {
            console.error('Payment not found:', InvId);
            return res.status(404).send('Payment not found');
        }

        if (payment.status === 'completed') {
            console.log('Payment already processed:', InvId);
            return res.send(`OK${InvId}`);
        }

        // Обновляем статус платежа
        await updatePayment(
            { _id: payment._id },
            { status: 'completed', paidAt: new Date() }
        );

        // Активируем подписку
        await activateSubscription(payment.userId, {
            OutSum,
            InvId,
            ...customParams
        });

        // Добавляем пользователя в чат
        const result = await addUserToChat(payment.userId);
        if (result.success && result.link) {
            try {
                await bot.telegram.sendMessage(
                    payment.userId,
                    `🎉 *Оплата прошла успешно!*\n\n` +
                    `Добро пожаловать в наше сообщество! Перейдите по ссылке для доступа: ${result.link}`,
                    { parse_mode: 'Markdown' }
                );
            } catch (error) {
                console.error('Error sending message:', error);
            }
        }

        res.send(`OK${InvId}`);
    } catch (error) {
        console.error('Error in webhook:', error);
        res.status(500).send('error');
    }
});

// Главная панель администратора
bot.action('admin_panel', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Нет доступа');

    await ctx.editMessageText('⚙️ Панель администратора', {
        reply_markup: {
            inline_keyboard: [
                [{ text: '👥 Список пользователей', callback_data: 'admin_users' }],
                [{ text: '🔍 Проверить пользователя', callback_data: 'admin_check' }],
                [{ text: '📊 Статистика', callback_data: 'admin_stats' }],
                [{ text: '⬅️ Выйти', callback_data: 'admin_exit' }]
            ]
        }
    });
});

// Список пользователей
bot.action('admin_users', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Нет доступа');

    const users = await paymentsCollection.find().limit(10).toArray();
    let text = '👥 *Список пользователей (первые 10):*\n\n';
    users.forEach(u => {
        text += `• ID: ${u.userId}, Username: @${u.username || '-'}, Статус: ${u.status}\n`;
    });

    await ctx.editMessageText(text || '❌ Пользователей нет', {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: '⬅️ Назад', callback_data: 'admin_panel' }]
            ]
        }
    });
});

// Проверить пользователя
bot.action('admin_check', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Нет доступа');

    await ctx.editMessageText('Введите ID пользователя для проверки.\n\n⬅️ Нажмите «Назад» чтобы вернуться.', {
        reply_markup: {
            inline_keyboard: [
                [{ text: '⬅️ Назад', callback_data: 'admin_panel' }]
            ]
        }
    });

    // Ждём ввод ID
    bot.once('text', async (msgCtx) => {
        if (!isAdmin(msgCtx.from.id)) return;

        const queryId = parseInt(msgCtx.message.text.trim());
        const user = await paymentsCollection.findOne({ userId: queryId });

        if (user) {
            await msgCtx.replyWithMarkdown(`
👤 *Информация о пользователе*  
ID: \`${user.userId}\`  
Username: @${user.username || '-'}  
Имя: ${user.firstName || ''} ${user.lastName || ''}  
Статус: ${user.status}  
Дата создания: ${user.createdAt}
            `, {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '⬅️ Назад в админку', callback_data: 'admin_panel' }]
                    ]
                }
            });
        } else {
            await msgCtx.reply('❌ Пользователь не найден', {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '⬅️ Назад в админку', callback_data: 'admin_panel' }]
                    ]
                }
            });
        }
    });
});

// Статистика
bot.action('admin_stats', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Нет доступа');

    const totalUsers = await paymentsCollection.distinct('userId');
    const totalPayments = await paymentsCollection.countDocuments();

    await ctx.editMessageText(`
📊 *Статистика*  
👥 Пользователей: ${totalUsers.length}  
💳 Платежей: ${totalPayments}
    `, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: '⬅️ Назад', callback_data: 'admin_panel' }]
            ]
        }
    });
});

// Выход из админки
bot.action('admin_exit', async (ctx) => {
    await ctx.editMessageText('✅ Вы вышли из админки');
});

// Показать оферту
bot.action('show_oferta', async (ctx) => {
    try {
        await ctx.answerCbQuery();
        await ctx.replyWithDocument({ source: './oferta.txt' });
    } catch (error) {
        console.error('Ошибка отправки оферты:', error);
        await ctx.reply('⚠️ Оферта временно недоступна');
    }
});

// Информация о подписке
bot.action("mysub", async (ctx) => {
    const sub = await subscriptionsCollection.findOne({ userId: ctx.from.id });
    if (!sub) {
        return ctx.editMessageText("❌ У вас нет активной подписки");
    }

    await ctx.editMessageText(`
📌 *Информация о подписке*
Статус: ${sub.status}
Действует до: ${sub.currentPeriodEnd.toLocaleDateString()}
    `, {
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: [
                [{ text: "⬅️ Назад", callback_data: "back_to_start" }]
            ]
        }
    });
});

// Возврат к началу
bot.action("back_to_start", async (ctx) => {
    await ctx.editMessageText(`
✅ *Вы уже имеете доступ к нашему сообществу!*

Если у вас возникли проблемы с доступом, обратитесь в техподдержку.
    `, {
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: [
                [{ text: "📌 Моя подписка", callback_data: "mysub" }],
                [{ text: "💬 Техподдержка", url: "https://t.me/golube123" }]
            ]
        }
    });
});

// Запуск приложения
async function startApp() {
    try {
        await connectToDatabase();
        console.log('✅ База данных инициализирована');

        // Проверяем доступ к чату
        const chatAccess = await checkChatAccess();
        if (!chatAccess) {
            console.warn('⚠️ Возможны проблемы с доступом к чату');
        }

        const PORT = process.env.PORT || 3000;
        app.listen(PORT, () => {
            console.log(`🚀 Сервер запущен на порту ${PORT}`);
        });

        await bot.launch();
        console.log('🤖 Бот успешно запущен');

    } catch (error) {
        console.error('❌ Фатальная ошибка при запуске:', error);
        process.exit(1);
    }
}

// Запускаем приложение
startApp();

// Graceful shutdown
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));