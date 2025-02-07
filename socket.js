const { Server } = require("socket.io");

let io;
let userSockets = {}; // Store user ID -> socket ID mapping

function initializeSocket(server, db) {
    io = new Server(server, {
        cors: {
            origin: "*",
            methods: ["GET", "POST"],
        },
        pingInterval: 25000, // Default is 25000 (25 seconds)
        pingTimeout: 60000, // Default is 60000 (60 seconds)
    });

    io.on("connection", (socket) => {
        // Store user socket mapping when a user connects
        socket.on("registerUser", (userId) => {
            if (userSockets[userId] !== socket.id) {
                userSockets[userId] = socket.id;

                // Mark all unread messages as delivered for the user upon connection
                db.query(`UPDATE messages SET delivered = TRUE WHERE receiver_id = ? AND delivered = FALSE`, [userId], (err) => {
                    if (err) {
                        console.error("Error marking messages as delivered:", err.message);
                    } else {
                        console.log(`All unread messages for user ${userId} marked as delivered`);

                        // Query for all unread messages for this user
                        db.query(
                            `SELECT * FROM messages WHERE receiver_id = ? AND delivered = TRUE AND is_read = FALSE`,
                            [userId],
                            (err, results) => {
                                if (err) {
                                    console.error("Error retrieving unread messages:", err.message);
                                    return;
                                }

                                // For each unread message, emit a 'messageDelivered' event to the sender
                                results.forEach((message) => {
                                    const senderSocketId = userSockets[message.sender_id];
                                    if (senderSocketId) {
                                        io.to(senderSocketId).emit("messageDelivered", {
                                            messageId: message.message_id,
                                            timestamp: new Date().toISOString(),
                                        });
                                    }
                                });
                            }
                        );
                    }
                });
            }
        });

        // Handle sending messages
        socket.on("sendMessage", (data) => {
            const { senderId, receiverId, text, tempId } = data;
            const receiverSocketId = userSockets[receiverId];
            const senderSocketId = userSockets[senderId];

            db.query(
                `
                    INSERT INTO messages (sender_id, receiver_id, message_text, timestamp, delivered)
                    VALUES (?, ?, ?, NOW(), ?);
                    `,
                [senderId, receiverId, text, !!receiverSocketId],
                (err, results) => {
                    if (err) {
                        console.error("Error saving message:", err.message);
                        return;
                    }

                    const messageId = results.insertId; // Retrieve the inserted message ID

                    io.to(senderSocketId).emit("messageSaved", { tempId, messageId, timestamp: new Date().toISOString() });

                    if (receiverSocketId) {
                        db.query(
                            `SELECT COUNT(*) AS unreadCount FROM messages WHERE receiver_id = ? AND is_read = FALSE`,
                            [receiverId],
                            (err, results) => {
                                if (err) {
                                    console.error("Error counting unread messages:", err.message);
                                    return;
                                }

                                const unreadCount = results[0]?.unreadCount || 0;

                                // Emit unread count as a separate event
                                io.to(receiverSocketId).emit("unreadMessagesCount", { unreadCount });

                                // Emit the received message
                                io.to(receiverSocketId).emit("receiveMessage", {
                                    messageId,
                                    senderId,
                                    message_text: text,
                                    timestamp: new Date().toISOString(),
                                });

                                io.to(senderSocketId).emit("messageDelivered", {
                                    messageId,
                                    timestamp: new Date().toISOString(),
                                });
                            }
                        );
                    }
                }
            );
        });

        socket.on("messageRead", (data) => {
            const { messageIds, senderId, receiverId } = data;

            if (!messageIds || messageIds.length === 0) {
                console.error("No message IDs provided.");
                return;
            }

            const senderSocketId = userSockets[senderId];

            // Update all messages in the database
            db.query(`UPDATE messages SET is_read = TRUE WHERE message_id IN (?)`, [messageIds], (err) => {
                if (err) {
                    console.error("Error updating message status:", err.message);
                    return;
                }
                if (senderSocketId) {
                    io.to(senderSocketId).emit("messageRead", {
                        receiverId,
                        messageIds,
                        timestamp: new Date().toISOString(),
                    });
                }
            });
        });

        // Handle typing event (show typing indicator)
        socket.on("typing", (data) => {
            const { senderId, receiverId } = data;
            const receiverSocketId = userSockets[receiverId];

            if (receiverSocketId) {
                io.to(receiverSocketId).emit("typing", { senderId, receiverId });
            }
        });

        socket.on("stopTyping", (data) => {
            const { senderId, receiverId } = data;
            const receiverSocketId = userSockets[receiverId];

            if (receiverSocketId) {
                io.to(receiverSocketId).emit("stopTyping", { senderId, receiverId });
            }
        });

        // Handle disconnect event and clean up the mapping
        socket.on("disconnect", (reason) => {
            // console.log(`User ${socket.id} disconnected due to ${reason}`);
            for (let userId in userSockets) {
                if (userSockets[userId] === socket.id) {
                    delete userSockets[userId];
                    // console.log(`User ${userId} removed from userSockets`);
                    break;
                }
            }
        });
    });
}

// Function to get io instance after initialization
function getIo() {
    if (!io) {
        throw new Error("Socket.io has not been initialized!");
    }
    return io;
}

// Function to get the latest userSockets reference
function getUserSockets() {
    return userSockets;
}

module.exports = { initializeSocket, getIo, getUserSockets };
