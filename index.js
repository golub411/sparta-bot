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

// Функция для добавления пользователя в чат/канал
async function addUserToChat(userId) {
    try {
        const chatId = process.env.CHANNEL_ID;
        
        // Пробуем получить информацию о чате
        const chat = await bot.telegram.getChat(chatId);
        
        if (chat.type === 'channel') {
            // Для каналов - получаем инвайт-ссылку
            try {
                const inviteLink = await bot.telegram.exportChatInviteLink(chatId);
                await bot.telegram.unbanChatMember(chatId, userId);
                return { success: true, link: inviteLink, type: 'channel' };
            } catch (error) {
                console.error('Ошибка с каналом:', error);
                throw error;
            }
        } else {
            // Для чатов/групп - добавляем пользователя напрямую
            try {
                await bot.telegram.unbanChatMember(chatId, userId);
                
                // Пробуем создать инвайт-ссылку для чата
                try {
                    const inviteLink = await bot.telegram.exportChatInviteLink(chatId);
                    return { success: true, link: inviteLink, type: 'chat' };
                } catch (linkError) {
                    // Если не можем создать ссылку, просто добавляем пользователя
                    return { success: true, link: null, type: 'chat' };
                }
            } catch (error) {
                console.error('Ошибка при добавлении в чат:', error);
                throw error;
            }
        }
        
    } catch (error) {
        console.error('Ошибка при добавлении пользователя:', error);
        throw error;
    }
}

// Функция для проверки доступа к чату
async function checkChatAccess() {
    try {
        const chatId = process.env.CHANNEL_ID;
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

            let message = `🎉 *Оплата успешно завершена!*\n\n`;
            
            if (result.success) {
                if (result.link) {
                    message += `Вот ваша персональная ссылка для доступа:\n${result.link}\n\n`;
                } else {
                    message += `Вы были добавлены в сообщество! Проверьте список чатов.\n\n`;
                }
                
                message += `📌 *Важно:* Не передавайте доступ другим пользователям!`;
                
                await ctx.editMessageText(message, {
                    parse_mode: 'Markdown',
                    reply_markup: result.link ? {
                        inline_keyboard: [
                            [{ text: '🚀 Перейти в сообщество', url: result.link }],
                            [{ text: '💬 Техподдержка', url: 'https://t.me/your_support' }]
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

            let message = `🎉 *Оплата успешно завершена!*\n\n`;
            
            if (result.success) {
                if (result.link) {
                    message += `Вот ваша персональная ссылка для доступа:\n${result.link}\n\n`;
                } else {
                    message += `Вы были добавлены в сообщество! Проверьте список чатов.\n\n`;
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