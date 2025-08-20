require('dotenv').config();
const { Telegraf } = require('telegraf');
const { YooCheckout } = require('@a2seven/yoo-checkout');
const { MongoClient } = require('mongodb');
const express = require('express');
const crypto = require('crypto');
const cron = require('node-cron');

// Загружаем администраторов из .env
const ADMINS = process.env.ADMINS ? process.env.ADMINS.split(',').map(id => id.trim()) : [];

// Проверка администратора
function isAdmin(userId) {
    return ADMINS.includes(userId.toString());
}

// Инициализация приложения
const app = express();
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

// Инициализация YooKassa
const checkout = new YooCheckout({
    shopId: process.env.YOOKASSA_SHOP_ID,
    secretKey: process.env.YOOKASSA_SECRET_KEY
});

// Подключение к MongoDB
let db;
let paymentsCollection;
let subscriptionsCollection;

async function activateSubscription(userId, paymentInfo) {
    const expiresAt = new Date();
    expiresAt.setMonth(expiresAt.getMonth() + 1); // подписка на 1 месяц

    await subscriptionsCollection.updateOne(
        { userId },
        {
            $set: {
                userId,
                status: 'active',
                currentPeriodEnd: expiresAt,
                autoRenew: true,
                lastPaymentId: paymentInfo.id,
                amount: paymentInfo.amount.value,
                updatedAt: new Date()
            }
        },
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
        
        // Создаем индексы для оптимизации
        await paymentsCollection.createIndex({ userId: 1 });
        await paymentsCollection.createIndex({ yooId: 1 });
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

// Функция для добавления пользователя в чат/канал через инвайт-ссылку
async function addUserToChat(userId) {
    try {
        const chatId = process.env.CHANNEL_ID;

        // Проверяем, не является ли пользователь уже участником
        const isAlreadyMember = await isUserInChat(userId);
        if (isAlreadyMember) {
            console.log(`✅ Пользователь ${userId} уже в чате`);
            return { success: true, alreadyMember: true, link: null };
        }

        // Проверяем, не является ли пользователь владельцем
        const isOwner = await isChatOwner(userId);
        if (isOwner) {
            console.log(`✅ Пользователь ${userId} - владелец чата`);
            return { success: true, isOwner: true, link: null };
        }

        // Пробуем получить информацию о чате
        const chat = await bot.telegram.getChat(chatId);

        // Для каналов и групп — генерируем инвайт-ссылку
        let inviteLink = null;
        try {
            inviteLink = await bot.telegram.exportChatInviteLink(chatId);
        } catch (linkError) {
            console.error('Не удалось создать инвайт-ссылку:', linkError.message);
        }

        if (inviteLink) {
            console.log(`🔗 Сгенерирована инвайт-ссылка для ${userId}: ${inviteLink}`);

            // Пробуем разбанить пользователя (если он был кикнут)
            try {
                await bot.telegram.unbanChatMember(chatId, userId);
            } catch (unbanError) {
                if (!(unbanError.response && unbanError.response.description.includes('not banned'))) {
                    console.error('Ошибка при разбане пользователя:', unbanError);
                }
            }

            return { success: true, link: inviteLink, type: chat.type };
        }

        throw new Error('Не удалось получить инвайт-ссылку');

    } catch (error) {
        console.error('Ошибка при добавлении пользователя:', error);
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


// Проверка подписи уведомлений от ЮКассы
function verifyNotificationSignature(body, signature, secret) {
    const message = `${body.event}.${body.object.id}`;
    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(message);
    return signature === hmac.digest('hex');
}

// Команда /start с проверкой наличия доступа
bot.command('start', async (ctx) => {
    try {
        const userId = ctx.from.id;
        
        // Если админ → показываем кнопку для входа в админку
        if (isAdmin(userId)) {
            return ctx.reply('⚙️ Добро пожаловать в панель администратора!', {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🚀 Войти в админку', callback_data: 'admin_panel' }]
                    ]
                }
            });
        }


        // Проверяем, есть ли уже пользователь в чате
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
        
        const paymentId = `yk_${Date.now()}_${userId}`;

        await createPayment({
            _id: paymentId,
            userId: userId,
            status: 'pending',
            username: ctx.from.username || 'нет username',
            firstName: ctx.from.first_name || '',
            lastName: ctx.from.last_name || ''
        });

        ctx.replyWithMarkdown(`
🎉 *Добро пожаловать в наше эксклюзивное сообщество!*

Для доступа к закрытому контенту оформите подписку на 1 месяц.

💎 *Преимущества подписки:*
✔️ Доступ к эксклюзивным материалам
✔️ Закрытые обсуждения
✔️ Персональные уведомления
✔️ Поддержка создателей

Стоимость подписки: *1000 рублей*
        `, {
            reply_markup: {
                inline_keyboard: [
                    [{ 
                        text: '💳 Оплатить подписку', 
                        callback_data: `init_pay:${paymentId}` 
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

// Главная панель
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

bot.action("mysub", async (ctx) => {
    const sub = await subscriptionsCollection.findOne({ userId: ctx.from.id });
    if (!sub) {
        return ctx.editMessageText("❌ У вас нет активной подписки");
    }

    await ctx.editMessageText(`
📌 *Информация о подписке*
Статус: ${sub.status}
Автопродление: ${sub.autoRenew ? "✅ Включено" : "❌ Отключено"}
Действует до: ${sub.currentPeriodEnd.toLocaleDateString()}
    `, {
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: [
                [{ 
                    text: sub.autoRenew ? "❌ Отключить автопродление" : "🔄 Включить автопродление", 
                    callback_data: "toggle_autorenew" 
                }],
                [{ text: "⬅️ Назад", callback_data: "back_to_start" }]
            ]
        }
    });
});

bot.action("toggle_autorenew", async (ctx) => {
    const sub = await subscriptionsCollection.findOne({ userId: ctx.from.id });
    if (!sub) return ctx.answerCbQuery("❌ Подписка не найдена");

    const newStatus = !sub.autoRenew;
    await subscriptionsCollection.updateOne(
        { userId: ctx.from.id },
        { $set: { autoRenew: newStatus, updatedAt: new Date() } }
    );

    await ctx.editMessageText(`
📌 *Информация о подписке*
Статус: ${sub.status}
Автопродление: ${newStatus ? "✅ Включено" : "❌ Отключено"}
Действует до: ${sub.currentPeriodEnd.toLocaleDateString()}
    `, {
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: [
                [{ 
                    text: newStatus ? "❌ Отключить автопродление" : "🔄 Включить автопродление", 
                    callback_data: "toggle_autorenew" 
                }],
                [{ text: "⬅️ Назад", callback_data: "back_to_start" }]
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

// Выход
bot.action('admin_exit', async (ctx) => {
    await ctx.editMessageText('✅ Вы вышли из админки');
});

// Обработка кнопки "Оплатить"
bot.action(/init_pay:(.+)/, async (ctx) => {
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

        await ctx.editMessageText(`
🔒 *Подтверждение платежа*

Вы оформляете подписку на наше сообщество:
▫️ Сумма: *1000 рублей*
▫️ Срок: *1 месяц*
▫️ Автопродление: *Нет*

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

        ctx.answerCbQuery();
    } catch (error) {
        console.error('Ошибка в init_pay:', error);
        ctx.answerCbQuery('⚠️ Произошла ошибка');
    }
});

// Подтверждение платежа
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

        await ctx.editMessageText('🔄 *Обработка платежа...*', { parse_mode: 'Markdown' });

        const createPayload = {
            amount: { value: '1000.00', currency: 'RUB' },
            payment_method_data: { type: 'bank_card' },
            confirmation: {
                type: 'redirect',
                return_url: `https://t.me/${ctx.botInfo.username}`
            },
            description: `Подписка на сообщество для пользователя ${userId}`,
            metadata: {
                userId: userId,
                paymentId: paymentId,
                username: ctx.from.username || 'нет username'
            },
            capture: true
        };

        const payment = await checkout.createPayment(createPayload);
        
        await updatePayment(
            { _id: paymentId },
            { 
                yooId: payment.id,
                status: 'waiting_for_capture',
                paymentUrl: payment.confirmation.confirmation_url
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
                        url: payment.confirmation.confirmation_url
                    }],
                    [{
                        text: '🔄 Проверить оплату',
                        callback_data: `check_payment:${paymentId}`
                    }]
                ]
            }
        });

        ctx.answerCbQuery();
    } catch (error) {
        console.error('Ошибка в confirm_pay:', error);
        ctx.editMessageText('⚠️ *Ошибка при обработке платежа*', { parse_mode: 'Markdown' });
    }
});

// Проверка платежа
bot.action(/check_payment:(.+)/, async (ctx) => {
    const paymentId = ctx.match[1];
    const userId = ctx.from.id;

    try {
        ctx.answerCbQuery('🔍 Проверяем платеж...');
        
        // Проверяем, есть ли уже доступ
        const isMember = await isUserInChat(userId);
        if (isMember) {
            await ctx.editMessageText(`
✅ *У вас уже есть доступ к сообществу!*

Оплата не требуется. Если возникли проблемы с доступом, обратитесь в техподдержку.
            `, { parse_mode: 'Markdown' });
            return;
        }

        const paymentData = await getPayment({ _id: paymentId, userId: userId });
        if (!paymentData || !paymentData.yooId) {
            throw new Error('Платеж не найден');
        }

        const paymentInfo = await checkout.getPayment(paymentData.yooId);

        if (paymentInfo.status === 'succeeded') {
            const result = await addUserToChat(userId);

            await updatePayment(
                { _id: paymentId },
                { 
                    status: 'completed',
                    paidAt: new Date(),
                    amount: paymentInfo.amount.value
                }
            );
            
            await activateSubscription(userId, paymentInfo);

            let message = `🎉 *Оплата успешно завершена!*\n\n`;
            
            if (result.success) {
                if (result.alreadyMember) {
                    message += `✅ Вы уже имеете доступ к сообществу!\n\n`;
                } else if (result.isOwner) {
                    message += `👑 Вы являетесь владельцем сообщества!\n\n`;
                } else if (result.link) {
                    message += `Вот ваша персональная ссылка для доступа:\n${result.link}\n\n`;
                } else {
                    message += `✅ Вы были добавлены в сообщество! Проверьте список чатов.\n\n`;
                }
                
                message += `📌 *Важно:* Не передавайте доступ другим пользователям!`;
                
                await ctx.editMessageText(message, {
                    parse_mode: 'Markdown',
                    reply_markup: result.link ? {
                        inline_keyboard: [
                            [{ text: '📌 Моя подписка', callback_data: 'mysub' }],
                            [{ text: '🚀 Перейти в сообщество', url: result.link }],
                            [{ text: '💬 Техподдержка', url: 'https://t.me/golube123' }]
                        ]
                    } : null
                });
            } else {
                await ctx.editMessageText(`
✅ *Оплата успешно завершена!*

Однако возникла проблема с доступом к сообществу. Пожалуйста, свяжитесь с техподдержкой.
                `, { parse_mode: 'Markdown' });
            }

        } else {
            ctx.answerCbQuery('⏳ Платеж еще не завершен', { show_alert: true });
        }

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
        const paymentData = await getPayment({ _id: paymentId, userId: userId });
        
        if (paymentData?.yooId) {
            try {
                await checkout.cancelPayment(paymentData.yooId);
            } catch (error) {
                console.error('Ошибка при отмене платежа:', error);
            }
        }

        await updatePayment(
            { _id: paymentId },
            { status: 'cancelled_by_user' }
        );

        await ctx.editMessageText(`
🗑 *Платеж отменен*

Вы можете оформить подписку в любое время, воспользовавшись командой /start

Хорошего дня! ☀️
        `, { parse_mode: 'Markdown' });

        ctx.answerCbQuery();
    } catch (error) {
        console.error('Ошибка в cancel_pay:', error);
        ctx.answerCbQuery('⚠️ Ошибка при отмене платежа');
    }
});

// Вебхук для ЮКассы
app.post('/yookassa-webhook', async (req, res) => {
    try {
        const signature = req.headers['content-signature'];
        
        if (!verifyNotificationSignature(req.body, signature, process.env.YOOKASSA_SECRET_KEY)) {
            console.error('Неверная подпись уведомления');
            return res.status(401).send();
        }

        const notification = req.body;
        const payment = notification.object;

        if (notification.event === 'payment.succeeded') {
            const paymentId = payment.metadata.paymentId;
            const userId = parseInt(payment.metadata.userId);

            const paymentData = await getPayment({ _id: paymentId, userId: userId });
            if (!paymentData) {
                return res.status(404).send('Payment not found');
            }

            // Проверяем, есть ли уже доступ
            const isMember = await isUserInChat(userId);
            if (isMember) {
                await updatePayment(
                    { _id: paymentId },
                    {
                        status: 'already_member',
                        paidAt: new Date(),
                        amount: payment.amount.value,
                        updatedAt: new Date()
                    }
                );
                
                await bot.telegram.sendMessage(userId, `
✅ *Оплата успешно завершена!*

У вас уже есть доступ к сообществу. Если возникли проблемы, обратитесь в техподдержку.
                `, { parse_mode: 'Markdown' });
                
                return res.status(200).send();
            }

            const result = await addUserToChat(userId);

            await updatePayment(
                { _id: paymentId },
                {
                    status: 'completed',
                    paidAt: new Date(),
                    amount: payment.amount.value,
                    updatedAt: new Date()
                }
            );

            await activateSubscription(userId, payment);

            let message = `🎉 *Оплата успешно завершена!*\n\n`;
            
            if (result.success) {
                if (result.alreadyMember) {
                    message += `✅ Вы уже имеете доступ к сообществу!\n\n`;
                } else if (result.isOwner) {
                    message += `👑 Вы являетесь владельцем сообщества!\n\n`;
                } else if (result.link) {
                    message += `Вот ваша персональная ссылка для доступа:\n${result.link}\n\n`;
                } else {
                    message += `✅ Вы были добавлены в сообщество! Проверьте список чатов.\n\n`;
                }
                
                message += `📌 *Важно:* Не передавайте доступ другим пользователям!`;
                
                await bot.telegram.sendMessage(userId, message, {
                    parse_mode: 'Markdown',
                    reply_markup: result.link ? {
                        inline_keyboard: [
                            [{ text: '🚀 Перейти в сообщество', url: result.link }]
                        ]
                    } : null
                });
            } else {
                await bot.telegram.sendMessage(userId, `
✅ *Оплата успешно завершена!*

Однако возникла проблема с доступом к сообществу. Пожалуйста, свяжитесь с техподдержкой.
                `, { parse_mode: 'Markdown' });
            }
        }

        res.status(200).send();
    } catch (error) {
        console.error('Ошибка в вебхуке:', error);
        res.status(500).send();
    }
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

cron.schedule('0 3 * * *', async () => {
    const now = new Date();
    const expiringSubs = await subscriptionsCollection.find({
        status: 'active',
        autoRenew: true,
        currentPeriodEnd: { $lte: now }
    }).toArray();

    for (const sub of expiringSubs) {
        try {
            const newPayment = await checkout.createPayment({
                amount: { value: '1000.00', currency: 'RUB' },
                capture: true,
                payment_method_id: sub.paymentMethodId,
                description: `Продление подписки для пользователя ${sub.userId}`,
                metadata: { userId: sub.userId }
            });

            if (newPayment.status === 'succeeded') {
                await activateSubscription(sub.userId, newPayment);
                await bot.telegram.sendMessage(sub.userId, "✅ Ваша подписка продлена на месяц!");
            } else {
                await subscriptionsCollection.updateOne(
                    { userId: sub.userId },
                    { $set: { status: 'past_due' } }
                );
                await bot.telegram.sendMessage(sub.userId, "⚠️ Автосписание не удалось. Попробуйте оплатить вручную через /start");
            }
        } catch (err) {
            console.error('Ошибка автопродления:', err);
        }
    }
});