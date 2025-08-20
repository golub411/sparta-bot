require('dotenv').config();
const { Telegraf } = require('telegraf');
const { YooCheckout } = require('@a2seven/yoo-checkout');
const { MongoClient } = require('mongodb');
const express = require('express');
const crypto = require('crypto');

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

async function connectToDatabase() {
    try {
        const client = new MongoClient(process.env.MONGODB_URI);
        await client.connect();
        console.log('✅ Успешно подключено к MongoDB');
        
        db = client.db();
        paymentsCollection = db.collection('payments');
        
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

// Кешируем пригласительную ссылку
let cachedInviteLink = null;

async function getInviteLink() {
    if (!cachedInviteLink) {
        try {
            cachedInviteLink = await bot.telegram.exportChatInviteLink(process.env.CHANNEL_ID);
        } catch (error) {
            console.error('Ошибка при получении инвайт-ссылки:', error);
            throw error;
        }
    }
    return cachedInviteLink;
}

// Проверка подписи уведомлений от ЮКассы
function verifyNotificationSignature(body, signature, secret) {
    const message = `${body.event}.${body.object.id}`;
    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(message);
    return signature === hmac.digest('hex');
}

// Команда /start
bot.command('start', async (ctx) => {
    try {
        const userId = ctx.from.id;
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
🎉 *Добро пожаловать в наш эксклюзивный канал!*

Для доступа к закрытому контенту оформите подписку на 1 месяц.

💎 *Преимущества подписки:*
✔️ Доступ к эксклюзивным материалам
✔️ Закрытые обсуждения
✔️ Персональные уведомления
✔️ Поддержка создателей

Стоимость подписки: *100 рублей*
        `, {
            reply_markup: {
                inline_keyboard: [
                    [{ 
                        text: '💳 Оплатить подписку', 
                        callback_data: `init_pay:${paymentId}` 
                    }],
                    [{ 
                        text: '❓ Помощь', 
                        url: 'https://t.me/your_support' 
                    }]
                ]
            }
        });

    } catch (error) {
        console.error('Ошибка в команде /start:', error);
        ctx.reply('⚠️ Произошла ошибка. Попробуйте позже.');
    }
});

// Обработка кнопки "Оплатить"
bot.action(/init_pay:(.+)/, async (ctx) => {
    const paymentId = ctx.match[1];
    const userId = ctx.from.id;

    try {
        const paymentData = await getPayment({ _id: paymentId, userId: userId });
        if (!paymentData) {
            return ctx.answerCbQuery('⚠️ Платеж не найден');
        }

        await ctx.editMessageText(`
🔒 *Подтверждение платежа*

Вы оформляете подписку на наш канал:
▫️ Сумма: *100 рублей*
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
        const paymentData = await getPayment({ _id: paymentId, userId: userId });
        if (!paymentData) {
            return ctx.answerCbQuery('⚠️ Платеж не найден');
        }

        await ctx.editMessageText('🔄 *Обработка платежа...*', { parse_mode: 'Markdown' });

        const createPayload = {
            amount: { value: '100.00', currency: 'RUB' },
            payment_method_data: { type: 'bank_card' },
            confirmation: {
                type: 'redirect',
                return_url: `https://t.me/${ctx.botInfo.username}`
            },
            description: `Подписка на канал для пользователя ${userId}`,
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

После успешной оплаты вы автоматически получите доступ к каналу.
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
        
        const paymentData = await getPayment({ _id: paymentId, userId: userId });
        if (!paymentData || !paymentData.yooId) {
            throw new Error('Платеж не найден');
        }

        const paymentInfo = await checkout.getPayment(paymentData.yooId);

        if (paymentInfo.status === 'succeeded') {
            const inviteLink = await getInviteLink();

            try {
                await bot.telegram.unbanChatMember(process.env.CHANNEL_ID, userId);
            } catch (e) {
                console.log('Пользователь не был забанен:', e.message);
            }

            await updatePayment(
                { _id: paymentId },
                { 
                    status: 'completed',
                    paidAt: new Date(),
                    amount: paymentInfo.amount.value
                }
            );

            await ctx.editMessageText(`
🎉 *Оплата успешно завершена!*

Спасибо за покупку подписки! Вот ваша персональная ссылка для доступа:

${inviteLink}

📌 *Важно:* Не передавайте эту ссылку другим пользователям!
            `, {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ 
                            text: '🚀 Перейти в канал', 
                            url: inviteLink 
                        }],
                        [{
                            text: '💬 Техподдержка', 
                            url: 'https://t.me/your_support' 
                        }]
                    ]
                }
            });

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

            const inviteLink = await getInviteLink();

            try {
                await bot.telegram.unbanChatMember(process.env.CHANNEL_ID, userId);
            } catch (e) {
                console.log('Ошибка при разбане пользователя:', e.message);
            }

            await updatePayment(
                { _id: paymentId },
                {
                    status: 'completed',
                    paidAt: new Date(),
                    amount: payment.amount.value,
                    updatedAt: new Date()
                }
            );

            await bot.telegram.sendMessage(userId, `
🎉 *Оплата успешно завершена!*

Спасибо за покупку подписки! Вот ваша персональная ссылка для доступа:

${inviteLink}

📌 *Важно:* Не передавайте эту ссылку другим пользователям!
            `, {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ 
                            text: '🚀 Перейти в канал', 
                            url: inviteLink 
                        }]
                    ]
                }
            });
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