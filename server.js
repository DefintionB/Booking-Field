const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const { MongoClient } = require("mongodb");
const dotenv = require("dotenv");
const bcrypt = require("bcrypt");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

dotenv.config();

const app = express();
const uri = process.env.DB_URI;
const saltRounds = parseInt(process.env.SALT_ROUNDS || "10", 10);

// ========== CORS Configuration ==========
const corsOptions = {
  origin: ["http://localhost:5173", "http://localhost:5174", "http://localhost:3000"],
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
  allowedHeaders: ["Content-Type", "Authorization"],
};

app.use(bodyParser.json());
app.use(cors(corsOptions));
app.use("/uploads", express.static("uploads"));

// ========== MULTER CONFIG ==========
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = "uploads/slips";
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueName = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, uniqueName + path.extname(file.originalname));
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif/;
    const extname = allowedTypes.test(
      path.extname(file.originalname).toLowerCase()
    );
    const mimetype = allowedTypes.test(file.mimetype);

    if (mimetype && extname) {
      return cb(null, true);
    }
    cb(new Error("Only image files are allowed!"));
  },
});

// ========== Helper Functions ==========
function getClient() {
  return new MongoClient(uri);
}

function timeToNumber(timeStr) {
  const [h, m] = timeStr.split(":").map(Number);
  return h + m / 60;
}

function isOverlap(startA, endA, startB, endB) {
  return !(endA <= startB || startA >= endB);
}

// ========== GET AVAILABLE COUPONS ==========
app.get("/CustomerCoupons/:customerId", async (req, res) => {
  const { customerId } = req.params;
  const client = getClient();

  try {
    await client.connect();
    const db = client.db("user");
    const couponsCol = db.collection("customerCoupons");

    const allCoupons = await couponsCol
      .find({ customerId, used: false })
      .toArray();

    const now = new Date();
    const validCoupons = allCoupons.filter((coupon) => {
      const createdDate = new Date(coupon.createdAt);
      const diffDays = (now - createdDate) / (1000 * 60 * 60 * 24);
      return diffDays <= 90;
    });

    const expiredCoupons = allCoupons.filter((coupon) => {
      const createdDate = new Date(coupon.createdAt);
      const diffDays = (now - createdDate) / (1000 * 60 * 60 * 24);
      return diffDays > 90;
    });

    if (expiredCoupons.length > 0) {
      const expiredIds = expiredCoupons.map((c) => c._id);
      await couponsCol.deleteMany({ _id: { $in: expiredIds } });
      console.log(`🗑️ Deleted ${expiredCoupons.length} expired coupons for ${customerId}`);
    }

    res.json({ success: true, coupons: validCoupons });
  } catch (err) {
    console.error(err);
    res.json({ success: false, message: "Cannot get coupons" });
  } finally {
    await client.close();
  }
});

// ========== REGISTER ==========
app.post("/Register", async (req, res) => {
  const { username, password } = req.body;
  const client = getClient();

  try {
    await client.connect();
    const db = client.db("user");
    const usersCol = db.collection("user");

    const existingUser = await usersCol.findOne({ username });
    if (existingUser) {
      return res.json({ success: false, message: "Username already exists" });
    }

    const lastUser = await usersCol
      .find()
      .sort({ customerId: -1 })
      .limit(1)
      .toArray();

    let nextCustomerId = "C001";
    if (lastUser.length > 0 && lastUser[0].customerId) {
      const lastNum = parseInt(lastUser[0].customerId.replace("C", ""));
      nextCustomerId = "C" + String(lastNum + 1).padStart(3, "0");
    }

    const hashedPassword = await bcrypt.hash(password, saltRounds);

    await usersCol.insertOne({
      customerId: nextCustomerId,
      username,
      password: hashedPassword,
      discount: 0,
    });

    res.json({ success: true, message: "Register successful" });
  } catch (error) {
    console.error(error);
    res.json({ success: false, message: "Register failed" });
  } finally {
    await client.close();
  }
});

// ========== LOGIN ==========
app.post("/Login", async (req, res) => {
  const { username, password } = req.body;
  const client = getClient();

  try {
    await client.connect();
    const db = client.db("user");
    const usersCol = db.collection("user");

    const user = await usersCol.findOne({ username });
    if (!user) {
      return res.json({ success: false, message: "User not found" });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.json({ success: false, message: "Wrong password" });
    }

    res.json({
      success: true,
      message: "Login successful",
      token: "temporary-token",
      customerId: user.customerId,
      username: user.username,
    });
  } catch (error) {
    console.error(error);
    res.json({ success: false, message: "Login failed" });
  } finally {
    await client.close();
  }
});

// ========== ADMIN LOGIN ==========
app.post("/AdminLogin", async (req, res) => {
  const { username, password } = req.body;
  const ADMIN_USERNAME = "admin";
  const ADMIN_PASSWORD = "Poon2005";

  if (!username || !password) {
    return res.json({
      success: false,
      message: "Please provide username and password",
    });
  }

  if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
    return res.json({
      success: true,
      message: "Admin login successful",
      token: "admin-token-secure",
      role: "admin",
      username: ADMIN_USERNAME,
    });
  }

  res.json({ success: false, message: "Invalid admin credentials" });
});

// ========== CREATE BOOKING ==========
app.post("/Bookings", async (req, res) => {
  const { customerId, fieldId, date, startTime, endTime, useCoupon } = req.body;
  const client = getClient();

  if (!customerId || !fieldId || !date || !startTime || !endTime) {
    return res.json({ success: false, message: "Missing booking data" });
  }

  try {
    await client.connect();
    const db = client.db("user");
    const bookingsCol = db.collection("bookings");
    const usersCol = db.collection("user");
    const couponsCol = db.collection("customerCoupons");

    const user = await usersCol.findOne({ customerId });
    const username = user ? user.username : null;

    const existingBookings = await bookingsCol
      .find({ fieldId, date, status: { $ne: "cancel" } })
      .toArray();

    const start = timeToNumber(startTime);
    const end = timeToNumber(endTime);

    const conflict = existingBookings.some((b) => {
      const bStart = timeToNumber(b.startTime);
      const bEnd = timeToNumber(b.endTime);
      return isOverlap(start, end, bStart, bEnd);
    });

    if (conflict) {
      return res.json({
        success: false,
        message: "This time slot has already been booked.",
      });
    }

    let pricePerHour = 1500;
    if (fieldId === "F003" || fieldId === "F004") pricePerHour = 2500;

    const hours = end - start;
    const basePrice = hours * pricePerHour;

    const DISCOUNT_RATE = 0.2;
    const DISCOUNT_START_HOUR = 9;
    const DISCOUNT_END_HOUR = 16;

    let discount = 0;
    let finalPrice = basePrice;

    if (start >= DISCOUNT_START_HOUR && end <= DISCOUNT_END_HOUR) {
      discount = basePrice * DISCOUNT_RATE;
      finalPrice = basePrice - discount;
    }

    let usedCouponId = null;
    let customerDiscount = 0;

    if (useCoupon === true) {
      const availableCoupon = await couponsCol.findOne({
        customerId,
        fieldId,
        used: false,
      });

      if (availableCoupon) {
        const createdDate = new Date(availableCoupon.createdAt);
        const diffDays = (new Date() - createdDate) / (1000 * 60 * 60 * 24);

        if (diffDays <= 90) {
          customerDiscount = 300;
          finalPrice = Math.max(0, finalPrice - customerDiscount);
          usedCouponId = availableCoupon._id;
        } else {
          console.log(`⏰ Coupon expired: ${availableCoupon._id}`);
          await couponsCol.deleteOne({ _id: availableCoupon._id });
        }
      }
    }

    const lastBooking = await bookingsCol
      .find()
      .sort({ bookingId: -1 })
      .limit(1)
      .toArray();

    let nextBookingId = "B001";
    if (lastBooking.length > 0 && lastBooking[0].bookingId) {
      const lastNum = parseInt(lastBooking[0].bookingId.replace("B", ""));
      nextBookingId = "B" + String(lastNum + 1).padStart(3, "0");
    }

    await bookingsCol.insertOne({
      bookingId: nextBookingId,
      fieldId,
      customerId,
      username,
      date,
      startTime,
      endTime,
      hours,
      pricePerHour,
      basePrice,
      discount,
      customerDiscount,
      finalPrice,
      status: "pending",
      paymentSlip: null,
      transferDate: null,
      transferTime: null,
      transferAmount: null,
      usedCouponId,
      warnings: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    if (usedCouponId) {
      await couponsCol.deleteOne({ _id: usedCouponId });
      console.log(`🗑️ Coupon deleted: ${usedCouponId}`);
    }

    console.log("✅ Booking created:", nextBookingId);

    res.json({
      success: true,
      message: "Booking created",
      bookingId: nextBookingId,
      priceInfo: { hours, basePrice, discount, customerDiscount, finalPrice },
    });
  } catch (err) {
    console.error(err);
    res.json({ success: false, message: "Booking failed" });
  } finally {
    await client.close();
  }
});

// ========== CANCEL BOOKING (ลูกค้า) - ให้คูปอง 300 ==========
app.patch("/Bookings/:bookingId/cancel", async (req, res) => {
  const { bookingId } = req.params;
  const { customerId } = req.body;
  const client = getClient();

  try {
    await client.connect();
    const db = client.db("user");
    const bookingsCol = db.collection("bookings");
    const couponsCol = db.collection("customerCoupons");

    const booking = await bookingsCol.findOne({ bookingId });

    if (!booking) {
      return res.json({ success: false, message: "Booking not found" });
    }

    if (booking.customerId !== customerId) {
      return res.json({ success: false, message: "Unauthorized" });
    }

    if (booking.status === "cancel") {
      return res.json({ success: false, message: "Booking already cancelled" });
    }

    if (booking.usedCouponId) {
      await couponsCol.updateOne(
        { _id: booking.usedCouponId },
        {
          $set: {
            used: false,
            bookingId: null,
            usedAt: null,
          },
        }
      );
    }

    await bookingsCol.updateOne(
      { bookingId },
      { $set: { status: "cancel", updatedAt: new Date() } }
    );

    await couponsCol.insertOne({
      customerId,
      fieldId: booking.fieldId,
      amount: 300,
      reason: `Cancelled booking ${bookingId}`,
      used: false,
      createdAt: new Date(),
    });

    console.log(
      `✅ Booking cancelled: ${bookingId}, 300 Baht coupon given for ${booking.fieldId}`
    );

    res.json({
      success: true,
      message: `Booking cancelled. You received 300 Baht coupon for ${booking.fieldId}!`,
    });
  } catch (err) {
    console.error(err);
    res.json({ success: false, message: "Cancel failed" });
  } finally {
    await client.close();
  }
});

// ========== DELETE BOOKING (ลบการจอง + คืนคูปอง) ==========
app.delete("/Bookings/:bookingId", async (req, res) => {
  const { bookingId } = req.params;
  const { customerId } = req.query;
  const client = getClient();

  try {
    await client.connect();
    const db = client.db("user");
    const bookingsCol = db.collection("bookings");
    const couponsCol = db.collection("customerCoupons");

    const booking = await bookingsCol.findOne({ bookingId });

    if (!booking) {
      return res.json({ success: false, message: "Booking not found" });
    }

    if (booking.customerId !== customerId) {
      return res.json({ success: false, message: "Unauthorized" });
    }

    if (booking.usedCouponId) {
      await couponsCol.updateOne(
        { _id: booking.usedCouponId },
        {
          $set: {
            used: false,
            bookingId: null,
            usedAt: null,
          },
        }
      );
      console.log(`💰 Refunded coupon to ${customerId}`);
    }

    await bookingsCol.deleteOne({ bookingId });

    console.log(`🗑️ Deleted booking: ${bookingId}`);

    res.json({
      success: true,
      message: "Booking deleted successfully",
    });
  } catch (err) {
    console.error(err);
    res.json({ success: false, message: "Delete failed" });
  } finally {
    await client.close();
  }
});

// ========== UPDATE BOOKING (แก้วัน/เวลา ก่อนอัปสลิป) ==========
app.patch("/Bookings/:bookingId/update", async (req, res) => {
  const { bookingId } = req.params;
  const { customerId, date, startTime, endTime } = req.body;
  const client = getClient();

  try {
    await client.connect();
    const db = client.db("user");
    const bookingsCol = db.collection("bookings");

    const booking = await bookingsCol.findOne({ bookingId });

    if (!booking) {
      return res.json({ success: false, message: "Booking not found" });
    }

    if (booking.customerId !== customerId) {
      return res.json({ success: false, message: "Unauthorized" });
    }

    if (booking.paymentSlip) {
      return res.json({
        success: false,
        message: "Cannot edit after uploading payment slip",
      });
    }

    const existingBookings = await bookingsCol
      .find({
        fieldId: booking.fieldId,
        date,
        bookingId: { $ne: bookingId },
        status: { $ne: "cancel" },
      })
      .toArray();

    const start = timeToNumber(startTime);
    const end = timeToNumber(endTime);

    const conflict = existingBookings.some((b) => {
      const bStart = timeToNumber(b.startTime);
      const bEnd = timeToNumber(b.endTime);
      return isOverlap(start, end, bStart, bEnd);
    });

    if (conflict) {
      return res.json({
        success: false,
        message: "This time slot has already been booked.",
      });
    }

    const hours = end - start;
    const basePrice = hours * booking.pricePerHour;

    const DISCOUNT_RATE = 0.2;
    const DISCOUNT_START_HOUR = 9;
    const DISCOUNT_END_HOUR = 16;

    let discount = 0;
    let finalPrice = basePrice;

    if (start >= DISCOUNT_START_HOUR && end <= DISCOUNT_END_HOUR) {
      discount = basePrice * DISCOUNT_RATE;
      finalPrice = basePrice - discount;
    }

    if (booking.customerDiscount > 0) {
      finalPrice = Math.max(0, finalPrice - booking.customerDiscount);
    }

    await bookingsCol.updateOne(
      { bookingId },
      {
        $set: {
          date,
          startTime,
          endTime,
          hours,
          basePrice,
          discount,
          finalPrice,
          updatedAt: new Date(),
        },
      }
    );

    console.log("✅ Booking updated:", bookingId);

    res.json({
      success: true,
      message: "Booking updated",
      priceInfo: {
        hours,
        basePrice,
        discount,
        customerDiscount: booking.customerDiscount,
        finalPrice,
      },
    });
  } catch (err) {
    console.error(err);
    res.json({ success: false, message: "Update failed" });
  } finally {
    await client.close();
  }
});

// ========== UPLOAD PAYMENT SLIP ครั้งแรก ==========
app.post(
  "/Bookings/:bookingId/upload-slip",
  upload.single("slip"),
  async (req, res) => {
    const { bookingId } = req.params;
    const { transferDate, transferTime, transferAmount } = req.body;
    const client = getClient();

    if (!req.file) {
      return res.json({ success: false, message: "No file uploaded" });
    }

    try {
      await client.connect();
      const db = client.db("user");
      const bookingsCol = db.collection("bookings");

      const slipPath = `/uploads/slips/${req.file.filename}`;

      const result = await bookingsCol.updateOne(
        { bookingId },
        {
          $set: {
            paymentSlip: slipPath,
            transferDate,
            transferTime,
            transferAmount: parseFloat(transferAmount),
            status: "verify",
            updatedAt: new Date(),
          },
        }
      );

      if (result.matchedCount === 0) {
        return res.json({ success: false, message: "Booking not found" });
      }

      console.log("✅ Payment slip uploaded:", bookingId);

      res.json({
        success: true,
        message: "Payment slip uploaded",
        slipPath,
      });
    } catch (err) {
      console.error(err);
      res.json({ success: false, message: "Upload failed" });
    } finally {
      await client.close();
    }
  }
);

// ========== UPDATE PAYMENT INFO (แก้เวลาโอน + สลิปใหม่ ตอน verify) ==========
app.patch(
  "/Bookings/:bookingId/payment/update",
  upload.single("paymentSlip"),
  async (req, res) => {
    const { bookingId } = req.params;
    const { customerId, transferDate, transferTime, transferAmount } = req.body;
    const client = getClient();

    try {
      await client.connect();
      const db = client.db("user");
      const bookingsCol = db.collection("bookings");

      const booking = await bookingsCol.findOne({ bookingId });

      if (!booking) {
        return res.json({ success: false, message: "Booking not found" });
      }

      if (booking.customerId !== customerId) {
        return res.json({ success: false, message: "Unauthorized" });
      }

      if (booking.status !== "verify") {
        return res.json({
          success: false,
          message: "You can edit payment only when status is verifying.",
        });
      }

      const updateFields = {
        transferDate: transferDate || booking.transferDate,
        transferTime: transferTime || booking.transferTime,
        transferAmount: transferAmount
          ? parseFloat(transferAmount)
          : booking.transferAmount,
        updatedAt: new Date(),
      };

      if (req.file) {
        const newSlipPath = `/uploads/slips/${req.file.filename}`;

        // ลบไฟล์สลิปเก่า ถ้ามี
        if (booking.paymentSlip) {
          const oldFileName = path.basename(booking.paymentSlip);
          const oldPath = path.join(process.cwd(), "uploads", "slips", oldFileName);
          fs.access(oldPath, fs.constants.F_OK, (err) => {
            if (!err) {
              fs.unlink(oldPath, (err) => {
                if (err) console.error("❌ Cannot delete old slip:", err);
              });
            }
          });
        }

        updateFields.paymentSlip = newSlipPath;
      }

      await bookingsCol.updateOne(
        { bookingId },
        {
          $set: updateFields,
        }
      );

      console.log("✅ Payment updated:", bookingId);

      res.json({
        success: true,
        message: "Payment info updated",
      });
    } catch (err) {
      console.error(err);
      res.json({ success: false, message: "Update payment failed" });
    } finally {
      await client.close();
    }
  }
);

// ========== TOURNAMENT ROUTES (เหมือนเดิม) ==========
app.get("/Tournaments", async (req, res) => {
  const client = getClient();

  try {
    await client.connect();
    const db = client.db("user");
    const tournamentsCol = db.collection("tournaments");

    const tournaments = await tournamentsCol
      .find()
      .sort({ startDate: -1 })
      .toArray();

    res.json({ success: true, tournaments });
  } catch (err) {
    console.error(err);
    res.json({ success: false, message: "Cannot load tournaments" });
  } finally {
    await client.close();
  }
});

app.get("/Tournaments/:tournamentId", async (req, res) => {
  const { tournamentId } = req.params;
  const client = getClient();

  try {
    await client.connect();
    const db = client.db("user");
    const tournamentsCol = db.collection("tournaments");

    const tournament = await tournamentsCol.findOne({ tournamentId });

    if (!tournament) {
      return res.json({ success: false, message: "Tournament not found" });
    }

    res.json({ success: true, tournament });
  } catch (err) {
    console.error(err);
    res.json({ success: false, message: "Cannot load tournament" });
  } finally {
    await client.close();
  }
});

app.post("/Tournaments", async (req, res) => {
  const {
    name,
    startDate,
    endDate,
    competitionType,
    entryFee,
    prizes,
    maxTeams,
  } = req.body;

  const client = getClient();

  try {
    await client.connect();
    const db = client.db("user");
    const tournamentsCol = db.collection("tournaments");

    const lastTournament = await tournamentsCol
      .find()
      .sort({ tournamentId: -1 })
      .limit(1)
      .toArray();

    let nextTournamentId = "T001";
    if (lastTournament.length > 0 && lastTournament[0].tournamentId) {
      const lastNum = parseInt(lastTournament[0].tournamentId.replace("T", ""));
      nextTournamentId = "T" + String(lastNum + 1).padStart(3, "0");
    }

    await tournamentsCol.insertOne({
      tournamentId: nextTournamentId,
      name,
      startDate,
      endDate,
      competitionType,
      entryFee,
      prizes: prizes || {
        first: 10000,
        second: 5000,
        third: 3000,
      },
      maxTeams: maxTeams || 16,
      registeredTeams: [],
      status: "open",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    console.log("✅ Tournament created:", nextTournamentId);

    res.json({
      success: true,
      message: "Tournament created",
      tournamentId: nextTournamentId,
    });
  } catch (err) {
    console.error(err);
    res.json({ success: false, message: "Failed to create tournament" });
  } finally {
    await client.close();
  }
});

app.post("/Tournaments/:tournamentId/register", async (req, res) => {
  const { tournamentId } = req.params;
  const { customerId, teamName, players } = req.body;

  if (!teamName || !players || players.length === 0) {
    return res.json({
      success: false,
      message: "Team name and players are required",
    });
  }

  const client = getClient();

  try {
    await client.connect();
    const db = client.db("user");
    const tournamentsCol = db.collection("tournaments");
    const usersCol = db.collection("user");

    const tournament = await tournamentsCol.findOne({ tournamentId });

    if (!tournament) {
      return res.json({ success: false, message: "Tournament not found" });
    }

    if (tournament.status !== "open") {
      return res.json({
        success: false,
        message: "Tournament registration is closed",
      });
    }

    if (tournament.registeredTeams.length >= tournament.maxTeams) {
      return res.json({ success: false, message: "Tournament is full" });
    }

    const alreadyRegistered = tournament.registeredTeams.some(
      (team) => team.customerId === customerId
    );

    if (alreadyRegistered) {
      return res.json({
        success: false,
        message: "You have already registered for this tournament",
      });
    }

    const user = await usersCol.findOne({ customerId });

    const teamData = {
      teamId: `TEAM${tournament.registeredTeams.length + 1}`.padStart(6, "0"),
      customerId,
      username: user?.username || "Unknown",
      teamName,
      players,
      registeredAt: new Date(),
      paid: false,
      paymentSlip: null,
    };

    await tournamentsCol.updateOne(
      { tournamentId },
      {
        $push: { registeredTeams: teamData },
        $set: { updatedAt: new Date() },
      }
    );

    console.log(`✅ Team registered: ${teamName} for ${tournamentId}`);

    res.json({
      success: true,
      message: "Team registered successfully",
      teamId: teamData.teamId,
    });
  } catch (err) {
    console.error(err);
    res.json({ success: false, message: "Registration failed" });
  } finally {
    await client.close();
  }
});

app.post(
  "/Tournaments/:tournamentId/teams/:teamId/payment",
  upload.single("slip"),
  async (req, res) => {
    const { tournamentId, teamId } = req.params;
    const { customerId } = req.body;

    if (!req.file) {
      return res.json({ success: false, message: "No file uploaded" });
    }

    const client = getClient();

    try {
      await client.connect();
      const db = client.db("user");
      const tournamentsCol = db.collection("tournaments");

      const slipPath = `/uploads/slips/${req.file.filename}`;

      const result = await tournamentsCol.updateOne(
        {
          tournamentId,
          "registeredTeams.teamId": teamId,
          "registeredTeams.customerId": customerId,
        },
        {
          $set: {
            "registeredTeams.$.paymentSlip": slipPath,
            "registeredTeams.$.paid": true,
            updatedAt: new Date(),
          },
        }
      );

      if (result.matchedCount === 0) {
        return res.json({ success: false, message: "Team not found" });
      }

      console.log(`✅ Payment slip uploaded for team: ${teamId}`);

      res.json({
        success: true,
        message: "Payment slip uploaded",
        slipPath,
      });
    } catch (err) {
      console.error(err);
      res.json({ success: false, message: "Upload failed" });
    } finally {
      await client.close();
    }
  }
);

app.get("/MyTournaments/:customerId", async (req, res) => {
  const { customerId } = req.params;
  const client = getClient();

  try {
    await client.connect();
    const db = client.db("user");
    const tournamentsCol = db.collection("tournaments");

    const myTournaments = await tournamentsCol
      .find({ "registeredTeams.customerId": customerId })
      .toArray();

    const result = myTournaments.map((tournament) => {
      const myTeam = tournament.registeredTeams.find(
        (team) => team.customerId === customerId
      );

      return {
        tournamentId: tournament.tournamentId,
        name: tournament.name,
        startDate: tournament.startDate,
        endDate: tournament.endDate,
        competitionType: tournament.competitionType,
        entryFee: tournament.entryFee,
        prizes: tournament.prizes,
        status: tournament.status,
        myTeam,
      };
    });

    res.json({ success: true, tournaments: result });
  } catch (err) {
    console.error(err);
    res.json({ success: false, message: "Cannot load tournaments" });
  } finally {
    await client.close();
  }
});

app.patch("/Tournaments/:tournamentId/status", async (req, res) => {
  const { tournamentId } = req.params;
  const { status } = req.body;

  const allowed = ["open", "ongoing", "completed", "cancelled"];
  if (!allowed.includes(status)) {
    return res.json({ success: false, message: "Invalid status" });
  }

  const client = getClient();

  try {
    await client.connect();
    const db = client.db("user");
    const tournamentsCol = db.collection("tournaments");

    const result = await tournamentsCol.updateOne(
      { tournamentId },
      { $set: { status, updatedAt: new Date() } }
    );

    if (result.matchedCount === 0) {
      return res.json({ success: false, message: "Tournament not found" });
    }

    console.log(`✅ Tournament status updated: ${tournamentId} -> ${status}`);

    res.json({ success: true, message: "Status updated" });
  } catch (err) {
    console.error(err);
    res.json({ success: false, message: "Cannot update status" });
  } finally {
    await client.close();
  }
});

// ========== GET BOOKINGS (fieldId + date) ==========
app.get("/Bookings", async (req, res) => {
  const { fieldId, date } = req.query;
  const client = getClient();

  if (!fieldId || !date) {
    return res.json({
      success: false,
      message: "fieldId and date are required",
    });
  }

  try {
    await client.connect();
    const db = client.db("user");
    const bookingsCol = db.collection("bookings");

    const bookings = await bookingsCol
      .find({
        fieldId,
        date,
        status: { $ne: "cancel" },
      })
      .toArray();

    res.json({ success: true, bookings });
  } catch (err) {
    console.error(err);
    res.json({ success: false, message: "Cannot load bookings" });
  } finally {
    await client.close();
  }
});

// ========== GET MY BOOKINGS ==========
app.get("/MyBookings/:customerId", async (req, res) => {
  const { customerId } = req.params;
  const client = getClient();

  try {
    await client.connect();
    const db = client.db("user");
    const bookingsCol = db.collection("bookings");

    const bookings = await bookingsCol
      .find({ customerId })
      .sort({ createdAt: -1 })
      .toArray();

    res.json({ success: true, bookings });
  } catch (err) {
    console.error(err);
    res.json({ success: false, message: "Cannot load bookings" });
  } finally {
    await client.close();
  }
});

// ========== GET ALL BOOKINGS (ADMIN) ==========
app.get("/AdminBookings", async (req, res) => {
  const client = getClient();

  try {
    await client.connect();
    const db = client.db("user");
    const bookingsCol = db.collection("bookings");

    const bookings = await bookingsCol
      .find()
      .sort({ createdAt: -1 })
      .toArray();

    res.json({ success: true, bookings });
  } catch (err) {
    console.error(err);
    res.json({ success: false, message: "Cannot load bookings" });
  } finally {
    await client.close();
  }
});

// ========== UPDATE BOOKING STATUS (ADMIN) ==========
app.patch("/Bookings/:bookingId/status", async (req, res) => {
  const { bookingId } = req.params;
  const { status } = req.body;

  const allowed = ["pending", "verify", "complete", "cancel"];
  if (!allowed.includes(status)) {
    return res.json({ success: false, message: "Invalid status" });
  }

  const client = getClient();

  try {
    await client.connect();
    const db = client.db("user");
    const bookingsCol = db.collection("bookings");
    const couponsCol = db.collection("customerCoupons");

    const booking = await bookingsCol.findOne({ bookingId });

    if (!booking) {
      return res.json({ success: false, message: "Booking not found" });
    }

    if (status === "cancel") {
      if (booking.usedCouponId) {
        await couponsCol.updateOne(
          { _id: booking.usedCouponId },
          {
            $set: {
              used: false,
              bookingId: null,
              usedAt: null,
            },
          }
        );
      }

      await couponsCol.insertOne({
        customerId: booking.customerId,
        fieldId: booking.fieldId,
        amount: 300,
        reason: `Admin cancelled booking ${bookingId}`,
        used: false,
        createdAt: new Date(),
      });

      console.log(
        `💰 Admin cancelled: Refunded coupon + 300 Baht for ${booking.customerId}`
      );
    }

    const result = await bookingsCol.updateOne(
      { bookingId },
      { $set: { status, updatedAt: new Date() } }
    );

    if (result.matchedCount === 0) {
      return res.json({ success: false, message: "Booking not found" });
    }

    console.log(`✅ Status updated: ${bookingId} -> ${status}`);

    res.json({ success: true, message: "Status updated" });
  } catch (err) {
    console.error(err);
    res.json({ success: false, message: "Cannot update status" });
  } finally {
    await client.close();
  }
});

// ========== SEND WARNING ==========
app.post("/Bookings/:bookingId/warning", async (req, res) => {
  const { bookingId } = req.params;
  const { message } = req.body;
  const client = getClient();

  if (!message) {
    return res.json({ success: false, message: "Warning message required" });
  }

  try {
    await client.connect();
    const db = client.db("user");
    const bookingsCol = db.collection("bookings");

    const warning = {
      message,
      timestamp: new Date(),
      read: false,
    };

    const result = await bookingsCol.updateOne(
      { bookingId },
      {
        $push: { warnings: warning },
        $set: { updatedAt: new Date() },
      }
    );

    if (result.matchedCount === 0) {
      return res.json({ success: false, message: "Booking not found" });
    }

    console.log(`⚠️ Warning sent to booking: ${bookingId}`);

    res.json({ success: true, message: "Warning sent" });
  } catch (err) {
    console.error(err);
    res.json({ success: false, message: "Cannot send warning" });
  } finally {
    await client.close();
  }
});

// ========== MARK WARNING AS READ ==========
app.patch("/Bookings/:bookingId/warning/read", async (req, res) => {
  const { bookingId } = req.params;
  const client = getClient();

  try {
    await client.connect();
    const db = client.db("user");
    const bookingsCol = db.collection("bookings");

    await bookingsCol.updateOne(
      { bookingId },
      { $set: { "warnings.$[].read": true } }
    );

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.json({ success: false });
  } finally {
    await client.close();
  }
});

app.listen(3000, () => {
  console.log("🚀 Server running at http://localhost:3000");
  console.log("✅ CORS enabled for:");
  console.log("   - http://localhost:5173");
  console.log("   - http://localhost:5174");
  console.log("   - http://localhost:3000");
});
