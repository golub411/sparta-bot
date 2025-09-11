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

// Добавьте эти строки в начало вашего express-приложения
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Конфигурация Robokassa
const ROBOKASSA_LOGIN = process.env.ROBOKASSA_LOGIN;
const ROBOKASSA_PASS1 = process.env.ROBOKASSA_PASS1; // Пароль 1 для создания платежей
const ROBOKASSA_PASS2 = process.env.ROBOKASSA_PASS2; // Пароль 2 для проверки вебхуков
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

// Middleware для обработки JSON
app.use(express.json());

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

// Функция для проверки доaccess к чату
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
        // Сортируем параметры по алфавиту и добавляем префикс shp_
        const sortedParams = Object.entries(customParams)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, value]) => [`shp_${key}`, value]);
        
        // Формируем строку параметров
        const paramsString = sortedParams
            .map(([key, value]) => `${key}=${value}`)
            .join(':');
        
        signatureString += `:${paramsString}`;
    }
    
    // Создаем MD5 хеш
    return crypto.createHash('md5').update(signatureString).digest('hex');
}

function verifyRobokassaSignature(OutSum, InvId, SignatureValue, customParams = {}) {
    if (!OutSum || !InvId || !SignatureValue) {
        console.error('Missing required parameters for signature verification');
        return false;
    }

    // Формируем базовую строку: OutSum:InvId:Пароль2
    let signatureString = `${OutSum}:${InvId}:${ROBOKASSA_PASS2}`;
    
    // Фильтруем и сортируем параметры с префиксом shp_
    const shpParams = {};
    Object.entries(customParams).forEach(([key, value]) => {
        if (key.startsWith('shp_')) {
            shpParams[key] = value;
        }
    });
    
    // Сортируем параметры по алфавиту
    const sortedKeys = Object.keys(shpParams).sort();
    
    // Добавляем параметры к строке подписи
    if (sortedKeys.length > 0) {
        const paramsString = sortedKeys.map(key => `${key}=${shpParams[key]}`).join(':');
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
        const baseUrl = ROBOKASSA_TEST_MODE 
            ? 'https://auth.robokassa.ru/Merchant/Index.aspx'
            : 'https://auth.robokassa.ru/Merchant/Index.aspx';
            
        const paymentUrl = `${baseUrl}?MerchantLogin=${ROBOKASSA_LOGIN}&OutSum=${OutSum}&InvoiceID=${InvId}&Description=${encodeURIComponent(description)}&SignatureValue=${signature}&Recurring=true&user_id=${userId}&shp_user_id=${userId}&shp_description=${encodeURIComponent(description)}`;

        await updatePayment(
            { _id: paymentId },
            { 
                robokassaId: InvId,
                status: 'waiting_payment',
                paymentUrl: paymentUrl,
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
                        url: paymentUrl
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
        
        // Формируем URL для проверки статуса
        const url = `https://auth.robokassa.ru/Merchant/WebService/Service.asmx/OpState?MerchantLogin=${login}&InvoiceID=${invId}&Signature=${crypto.createHash('md5').update(`${login}:${invId}:${password2}`).digest('hex')}`;
        
        const response = await fetch(url);
        const data = await response.text();
        
        // Парсим ответ и проверяем статус
        if (data.includes('State') && data.includes('code="100"')) {
            return true; // Платеж завершен
        }
        
        return false;
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
            const isPaid = await checkRobokassaPaymentStatus(paymentData.robokassaId);
            
            if (isPaid) {
                // Обновляем статус вручную
                await updatePayment(
                    { _id: paymentId },
                    { status: 'completed', paidAt: new Date() }
                );
                
                // Активируем подписку
                await activateSubscription(userId, {
                    OutSum: paymentData.amount,
                    InvId: paymentData.robokassaId
                });

                // Добавляем пользователя в чат
                const result = await addUserToChat(userId);
                
                if (result.success) {
                    if (result.alreadyMember) {
                        await ctx.editMessageText(`
✅ *Оплата прошла успешно!*

Вы уже состоите в нашем сообществе. Подписка продлена.
                        `, { parse_mode: 'Markdown' });
                    } else if (result.link) {
                        await ctx.editMessageText(`
✅ *Оплата прошла успешно!*

Добро пожаловать в наше сообщество! Перейдите по ссылке для доступа: ${result.link}
                        `, { parse_mode: 'Markdown' });
                    } else {
                        await ctx.editMessageText(`
✅ *Оплата прошла успешно!*

Добро пожаловать в наше сообщество! Вы были добавлены в группу.
                        `, { parse_mode: 'Markdown' });
                    }
                } else {
                    await ctx.editMessageText(`
✅ *Оплата прошла успешно!*

Возникла проблема с добавлением в группу. Свяжитесь с поддержкой.
                    `, { parse_mode: 'Markdown' });
                }
            } else {
                ctx.answerCbQuery('⏳ Платеж еще не завершен', { show_alert: true });
                return;
            }
        } else {
            // Платеж уже обработан
            await ctx.editMessageText(`
✅ *Платеж уже обработан!*

Вы уже имеете доступ к сообществу.
            `, { parse_mode: 'Markdown' });
        }
        
        ctx.answerCbQuery();
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
app.post('/recurrent', express.urlencoded({ extended: true }), async (req, res) => {
    console.log('📥 Получен recurrent вебхук:', req.body);
    
    try {
        const { OutSum, InvId, SignatureValue, SubscriptionId, ...customParams } = req.body;
        
        // Проверяем подпись
        if (!verifyRobokassaSignature(OutSum, InvId, SignatureValue, customParams)) {
            console.error('❌ Неверная подпись уведомления от Robokassa recurrent');
            return res.status(401).send('bad sign');
        }

        // Ищем подписку в базе
        const subscriptionData = await subscriptionsCollection.findOne({ 
            robokassaSubscriptionId: SubscriptionId
        });
        
        if (!subscriptionData) {
            console.error('❌ Подписка не найдена:', SubscriptionId);
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
                    lastPaymentAmount: parseFloat(OutSum),
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
            amount: parseFloat(OutSum),
            robokassaId: InvId,
            robokassaSubscriptionId: SubscriptionId,
            username: subscriptionData.username,
            firstName: subscriptionData.firstName,
            lastName: subscriptionData.lastName
        });

        // Отправляем уведомление пользователю
        try {
            await bot.telegram.sendMessage(
                userId,
                `🔄 *Произведено автоматическое списание за подписку*\n\n` +
                `Сумма: ${OutSum} руб.\n` +
                `Подписка активна до: ${newExpiryDate.toLocaleDateString('ru-RU')}`,
                { parse_mode: 'Markdown' }
            );
        } catch (error) {
            console.error('Ошибка отправки уведомления пользователю:', error);
        }

        console.log('✅ Обработан рекуррентный платеж для пользователя:', userId);
        res.send(`OK${InvId}`);
    } catch (error) {
        console.error('❌ Ошибка в Robokassa recurrent вебхуке:', error);
        res.status(500).send('error');
    }
});

// Обработчик для вебхука Robokassa (Result URL)
app.post('/robokassa-webhook', express.urlencoded({ extended: true }), async (req, res) => {
    console.log('📥 Получен вебхук от Robokassa:', req.body);
    
    try {
        const { OutSum, InvId, SignatureValue, ...customParams } = req.body;
        
        // Проверяем подпись
        if (!verifyRobokassaSignature(OutSum, InvId, SignatureValue, customParams)) {
            console.error('❌ Неверная подпись вебхука от Robokassa');
            return res.status(401).send('bad sign');
        }
        
        // Ищем платеж в базе данных
        const payment = await getPayment({ robokassaId: InvId });
        if (!payment) {
            console.error('❌ Платеж не найден:', InvId);
            return res.status(404).send('Payment not found');
        }

        // Если платеж уже обработан
        if (payment.status === 'completed') {
            console.log('ℹ️ Платеж уже обработан:', InvId);
            return res.send(`OK${InvId}`);
        }

        // Обновляем статус платежа
        await updatePayment(
            { _id: payment._id },
            { 
                status: 'completed', 
                paidAt: new Date(),
                // Сохраняем SubscriptionId для рекуррентных платежей
                robokassaSubscriptionId: customParams.SubscriptionId || null
            }
        );

        // Активируем подписку
        await activateSubscription(payment.userId, {
            OutSum,
            InvId,
            ...customParams
        });

        // Сохраняем SubscriptionId для рекуррентных платежей
        if (customParams.SubscriptionId) {
            await subscriptionsCollection.updateOne(
                { userId: payment.userId },
                { $set: { robokassaSubscriptionId: customParams.SubscriptionId } }
            );
        }

        // Добавляем пользователя в чат
        const result = await addUserToChat(payment.userId);
        if (result.success) {
            try {
                if (result.alreadyMember) {
                    await bot.telegram.sendMessage(
                        payment.userId,
                        `🎉 *Оплата прошла успешно!*\n\n` +
                        `Вы уже состоите в нашем сообществе. Подписка продлена.`,
                        { parse_mode: 'Markdown' }
                    );
                } else if (result.link) {
                    await bot.telegram.sendMessage(
                        payment.userId,
                        `🎉 *Оплата прошла успешно!*\n\n` +
                        `Добро пожаловать в наше сообщество! Перейдите по ссылке для доступа: ${result.link}`,
                        { parse_mode: 'Markdown' }
                    );
                } else {
                    await bot.telegram.sendMessage(
                        payment.userId,
                        `🎉 *Оплата прошла успешно!*\n\n` +
                        `Добро пожаловать в наше сообщество! Вы были добавлены в группу.`,
                        { parse_mode: 'Markdown' }
                    );
                }
            } catch (error) {
                console.error('Ошибка отправки сообщения:', error);
            }
        }

        console.log('✅ Обработан вебхук для платежа:', InvId);
        res.send(`OK${InvId}`);
    } catch (error) {
        console.error('❌ Ошибка в вебхуке:', error);
        res.status(500).send('error');
    }
});

// GET endpoint для вебхука (на случай, если Robokassa отправит GET)
app.get('/robokassa-webhook', async (req, res) => {
    console.log('📥 GET запрос к вебхуку:', req.query);
    // Перенаправляем на POST обработчик
    req.body = req.query;
    return app._router.handle(req, res);
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
        console.error('Ошибка отправки оферта:', error);
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