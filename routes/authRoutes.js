const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const db = require("../db");
const router = express.Router();

const { OAuth2Client } = require("google-auth-library");
const client = new OAuth2Client("702353220748-2lmc03lb4tcfnuqds67h8bbupmb1aa0q.apps.googleusercontent.com");

router.post("/register", async (req, res) => {
    const { email, username, password } = req.body;

    const hashedPassword = await bcrypt.hash(password, 10);

    const checkUserQuery = "SELECT * FROM users WHERE email = ? OR username = ?";
    db.query(checkUserQuery, [email, username], (err, result) => {
        if (err) {
            return res.status(500).json({
                success: false,
                error: err.message,
                data: null,
            });
        }

        if (result.length > 0) {
            const existingUser = result[0];
            if (existingUser.email === email) {
                return res.status(400).json({
                    success: false,
                    error: "User with the same email already exists.",
                    data: null,
                });
            }
            if (existingUser.username === username) {
                return res.status(400).json({
                    success: false,
                    error: "Username already taken.",
                    data: null,
                });
            }
        }

        const insertQuery = "INSERT INTO users (username, email, password) VALUES (?, ?, ?)";
        db.query(insertQuery, [username, email, hashedPassword], async (err, result) => {
            if (err) {
                return res.status(500).json({
                    success: false,
                    error: err.message,
                    data: null,
                });
            }

            // Create a JWT token after registration
            const user = { id: result.insertId, username, email }; // Adjust this as needed
            const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: "1h" });

            res.status(201).json({
                success: true,
                error: null,
                data: {
                    message: "User registered successfully",
                    token,
                    user: {
                        id: user.id,
                        username: user.username,
                        email: user.email,
                    },
                },
            });
        });
    });
});

// Login user
router.post("/login", (req, res) => {
    const { email, password } = req.body;

    const query = "SELECT id, username, email, password, profile_picture, is_private FROM users WHERE email = ?";

    db.query(query, [email], async (err, results) => {
        if (err || results.length === 0) {
            return res.status(400).json({
                success: false,
                error: "User not found",
                data: null,
            });
        }

        const user = results[0];
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(400).json({
                success: false,
                error: "Invalid credentials",
                data: null,
            });
        }

        const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: "1h" });

        res.json({
            success: true,
            error: null,
            data: {
                token: token,
                user: {
                    id: user.id,
                    username: user.username,
                    email: user.email,
                    profile_picture_url: user.profile_picture,
                    is_private: user.is_private,
                },
            },
        });
    });
});

router.post("/google-login", async (req, res) => {
    const { token } = req.body;

    try {
        // Verify the Google ID token
        const ticket = await client.verifyIdToken({
            idToken: token,
            audience: process.env.GOOGLE_CLIENT_ID,
        });

        const payload = ticket.getPayload();
        const { email, given_name: firstName, family_name: lastName } = payload;

        // Check if the user already exists in your database
        const query = "SELECT id, username, email, profile_picture FROM users WHERE email = ?";
        db.query(query, [email], async (err, results) => {
            if (err) {
                console.error("Database error:", err);
                return res.status(500).json({
                    success: false,
                    error: "Database error",
                    data: null,
                });
            }

            let user = results[0];

            if (!user) {
                // Create a new user if they don't exist
                const username = email.split("@")[0]; // Generate a username from email
                const insertQuery = `
                    INSERT INTO users (username, email, first_name, last_name, profile_picture, created_at, password)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                `;
                const insertValues = [username, email, firstName, lastName, payload.picture, new Date(), null];

                db.query(insertQuery, insertValues, (err, results) => {
                    if (err) {
                        console.error("Error creating user:", err);
                        return res.status(500).json({
                            success: false,
                            error: "Error creating user",
                            data: null,
                        });
                    }

                    const newUserId = results.insertId;
                    db.query("SELECT id, username, email, profile_picture FROM users WHERE id = ?", [newUserId], (err, results) => {
                        if (err || results.length === 0) {
                            console.error("Error fetching new user:", err);
                            return res.status(500).json({
                                success: false,
                                error: "Error fetching new user",
                                data: null,
                            });
                        }

                        user = results[0];
                        sendResponse(user, res);
                    });
                });
            } else {
                // User exists, send response
                sendResponse(user, res);
            }
        });
    } catch (error) {
        console.error("Error during Google login:", error);
        return res.status(401).json({
            success: false,
            error: "Invalid Google token or authentication failed",
            data: null,
        });
    }
});

// Helper function to send the response
const sendResponse = (user, res) => {
    const token = jwt.sign(
        {
            id: user.id,
            email: user.email,
            username: user.username,
        },
        process.env.JWT_SECRET || "secret123",
        { expiresIn: "1h" } // Token expiration time
    );

    // Return success response with user details and token
    return res.json({
        success: true,
        error: null,
        data: {
            token: token,
            user: {
                id: user.id,
                username: user.username,
                email: user.email,
                profile_picture_url: user.profile_picture,
            },
        },
    });
};

module.exports = router;
