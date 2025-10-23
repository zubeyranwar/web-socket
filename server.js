import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { parse } from 'url';

const server = createServer((req, res) => {
    // Add CORS headers for HTTP endpoints
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: 'OK',
            active_connections: clients.size,
            active_conversations: conversations.size,
            timestamp: new Date().toISOString()
        }));
    }
});
const wss = new WebSocketServer({ server });

// Store active connections and conversations
const clients = new Map();
const conversations = new Map();

wss.on('connection', (ws, request) => {
    const parameters = parse(request.url, true);
    const token = parameters.query.token;
    const pathParts = parameters.pathname.split('/');
    const conversationId = pathParts[3];

    console.log('🔌 New connection attempt:', { conversationId, hasToken: !!token });

    if (!conversationId) {
        ws.close(1008, 'Conversation ID required');
        return;
    }

    // For demo purposes, we'll accept any token or no token
    const user = {
        id: `user_${Date.now()}`,
        username: `User${Math.floor(Math.random() * 1000)}`
    };

    if (token) {
        console.log('Token provided, would validate in production');
    }

    // Store connection
    const connectionId = `${user.id}-${conversationId}`;
    clients.set(connectionId, { ws, user });
    
    // Initialize conversation if it doesn't exist
    if (!conversations.has(conversationId)) {
        conversations.set(conversationId, {
            messages: [],
            participants: new Map()
        });
    }

    const conversation = conversations.get(conversationId);
    conversation.participants.set(user.id, user);

    console.log(`✅ User ${user.username} connected to conversation ${conversationId}`);
    console.log(`👥 Active connections: ${clients.size}`);
    console.log(`👥 Participants in conversation ${conversationId}:`, Array.from(conversation.participants.values()).map(p => p.username));

    // Send connection confirmation
    ws.send(JSON.stringify({
        type: 'connection_established',
        user: user.username,
        conversation_id: conversationId,
        user_id: user.id
    }));

    // Send message history
    sendMessageHistory(ws, conversationId, user.id);

    ws.on('message', async (data) => {
        try {
            const message = JSON.parse(data.toString());
            console.log('📨 Received message type:', message.type);
            await handleMessage(ws, message, user, conversationId);
        } catch (error) {
            console.error('❌ Error processing message:', error);
            ws.send(JSON.stringify({
                type: 'error',
                error: 'Invalid message format'
            }));
        }
    });

    ws.on('close', () => {
        clients.delete(connectionId);
        const conversation = conversations.get(conversationId);
        if (conversation) {
            conversation.participants.delete(user.id);
            if (conversation.participants.size === 0) {
                conversations.delete(conversationId);
            }
        }
        console.log(`🔴 User ${user.username} disconnected from conversation ${conversationId}`);
        console.log(`👥 Remaining connections: ${clients.size}`);
    });

    ws.on('error', (error) => {
        console.error('💥 WebSocket error:', error);
        clients.delete(connectionId);
    });
});

async function handleMessage(ws, message, user, conversationId) {
    const { type } = message;

    switch (type) {
        case 'message':
            await handleNewMessage(ws, message, user, conversationId);
            break;
        
        case 'read':
            await handleReadReceipt(ws, message, user, conversationId);
            break;
        
        case 'typing':
            handleTypingIndicator(ws, message, user, conversationId);
            break;
        
        default:
            console.log('❓ Unknown message type:', type);
            ws.send(JSON.stringify({
                type: 'error',
                error: 'Unknown message type: ' + type
            }));
    }
}

async function handleNewMessage(ws, message, user, conversationId) {
    console.log('🔍 Raw message received:', message);

    // FIX: Extract properties from the message object
    const content = message.message; // This is the actual message content
    const attachments = message.attachments || [];
    const temp_id = message.temp_id;
    
    console.log('🔍 Extracted values:', {
        content: content,
        attachments: attachments,
        temp_id: temp_id
    });

    // Better content validation
    if (!content || typeof content !== 'string') {
        console.error('❌ Invalid message content:', content);
        ws.send(JSON.stringify({
            type: 'error',
            error: 'Message content is required and must be a string'
        }));
        return;
    }

    const trimmedContent = content.trim();
    if (trimmedContent === '') {
        console.error('❌ Empty message content after trimming');
        ws.send(JSON.stringify({
            type: 'error',
            error: 'Message content cannot be empty'
        }));
        return;
    }

    console.log(`💬 Processing message from ${user.username}: "${trimmedContent}"`);

    // Generate message ID
    const messageId = `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const timestamp = new Date().toISOString();

    // First, acknowledge the message with temp_id
    if (temp_id) {
        ws.send(JSON.stringify({
            type: 'message_ack',
            temp_id: temp_id,
            message_id: messageId,
            conversation_id: conversationId,
            status: 'sent'
        }));
        console.log(`✅ Sent acknowledgment for temp_id: ${temp_id}`);
    }

    // Create message object
    const messageObj = {
        type: 'message',
        message_id: messageId,
        message: trimmedContent,
        sender_id: user.id,
        sender_name: user.username,
        created_at: timestamp,
        attachments: attachments,
        conversation_id: conversationId,
        is_read: false
    };

    // Add to conversation history
    const conversation = conversations.get(conversationId);
    if (conversation) {
        conversation.messages.push(messageObj);
        // Keep only last 100 messages
        if (conversation.messages.length > 100) {
            conversation.messages = conversation.messages.slice(-100);
        }
    }

    // Broadcast to all users in the conversation (except sender)
    const broadcastCount = broadcastToConversation(conversationId, messageObj, user.id);
    console.log(`📢 Broadcasted message to ${broadcastCount} users in conversation ${conversationId}`);

    console.log(`💬 Message from ${user.username} in ${conversationId}: ${trimmedContent}`);
}

async function handleReadReceipt(ws, message, user, conversationId) {
    console.log(`👀 Read receipt from ${user.username} in ${conversationId}`);
    
    // Broadcast read receipt to other users in conversation
    const readReceipt = {
        type: 'read',
        reader_id: user.id,
        reader_name: user.username,
        conversation_id: conversationId,
        timestamp: new Date().toISOString()
    };

    const broadcastCount = broadcastToConversation(conversationId, readReceipt, user.id);
    console.log(`📢 Broadcasted read receipt to ${broadcastCount} users`);
}

function handleTypingIndicator(ws, message, user, conversationId) {
    const { is_typing } = message;
    
    const typingMsg = {
        type: 'typing',
        user_id: user.id,
        user_name: user.username,
        conversation_id: conversationId,
        is_typing: is_typing
    };

    broadcastToConversation(conversationId, typingMsg, user.id);
    
    if (is_typing) {
        console.log(`⌨️  ${user.username} is typing in ${conversationId}`);
    }
}

function broadcastToConversation(conversationId, message, excludeUserId = null) {
    let broadcastCount = 0;
    
    console.log(`🔍 Looking for connections in conversation ${conversationId}...`);
    console.log(`🔍 Total clients: ${clients.size}`);
    
    clients.forEach((clientData, connectionId) => {
        const [userId, userConversationId] = connectionId.split('-');
        
        console.log(`🔍 Checking connection: ${connectionId}, conversation: ${userConversationId}, exclude: ${excludeUserId}`);
        
        if (userConversationId === conversationId && userId !== excludeUserId) {
            const { ws, user } = clientData;
            if (ws.readyState === 1) { // WebSocket.OPEN
                try {
                    ws.send(JSON.stringify(message));
                    broadcastCount++;
                    console.log(`✅ Sent to ${user.username} (${userId})`);
                } catch (error) {
                    console.error(`❌ Failed to send to ${user.username}:`, error);
                }
            } else {
                console.log(`❌ ${user.username} connection not open (state: ${ws.readyState})`);
            }
        }
    });
    
    console.log(`📢 Successfully broadcasted to ${broadcastCount} users in conversation ${conversationId}`);
    return broadcastCount;
}

function sendMessageHistory(ws, conversationId, userId) {
    const conversation = conversations.get(conversationId);
    const messages = conversation ? conversation.messages : [];

    // If no messages, create a welcome message
    if (messages.length === 0) {
        const welcomeMessage = {
            id: 'welcome_1',
            type: 'message',
            message: 'Welcome to the chat! Start a conversation.',
            sender_id: 'system',
            sender_name: 'System',
            created_at: new Date().toISOString(),
            conversation_id: conversationId,
            is_read: true
        };
        messages.push(welcomeMessage);
        if (conversation) {
            conversation.messages = messages;
        }
    }

    ws.send(JSON.stringify({
        type: 'history',
        conversation_id: conversationId,
        messages: messages
    }));

    console.log(`📜 Sent ${messages.length} messages history to user ${userId}`);
}

// Health check endpoint
server.on('request', (req, res) => {
    if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: 'OK',
            active_connections: clients.size,
            active_conversations: conversations.size,
            conversations: Array.from(conversations.entries()).map(([id, conv]) => ({
                id,
                participants: Array.from(conv.participants.values()).map(p => p.username),
                message_count: conv.messages.length
            })),
            timestamp: new Date().toISOString()
        }));
    }
});

const PORT = process.env.WS_PORT || 8080;
server.listen(PORT, () => {
    console.log(`🚀 WebSocket server running on port ${PORT}`);
    console.log(`📡 WebSocket URL: ws://localhost:${PORT}`);
    console.log(`❤️  Health check: http://localhost:${PORT}/health`);
    console.log(`🔗 Connect using: ws://localhost:${PORT}/ws/chat/YOUR_CONVERSATION_ID?token=ANY_TOKEN`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('🛑 Shutting down WebSocket server...');
    wss.close(() => {
        server.close(() => {
            console.log('✅ WebSocket server closed');
            process.exit(0);
        });
    });
});

process.on('SIGINT', () => {
    console.log('🛑 Shutting down WebSocket server...');
    wss.close(() => {
        server.close(() => {
            console.log('✅ WebSocket server closed');
            process.exit(0);
        });
    });
});
