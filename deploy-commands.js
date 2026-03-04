import { REST, Routes } from "discord.js";
import dotenv from "dotenv";

dotenv.config();

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

const commands = [
  {
    name: "logtracker",
    description: "Check status or manage logtracker",
    options: [
      {
        type: 1,
        name: "run",
        description: "Run an action: status or logtracker",
        options: [
          {
            type: 5,
            name: "reset",
            description: "Reset current time tracker total hours.",
            required: false,
          },
          {
            type: 4,
            name: "id",
            description: "LogTracker ID",
            required: false,
          },
        ],
      },
    ],
  },
  {
    name: "clockin",
    description: "Clock in and start your session",
  },
  {
    name: "clockout",
    description: "Clock out and end your session",
  },
  {
    name: "status",
    description: "Show clock-in status",
    options: [
      {
        name: "user",
        type: 6,
        description: "View a specific user's status",
        required: false,
      },
      {
        name: "all",
        type: 5,
        description: "Show all active users (compact)",
        required: false,
      },
    ],
  },
  {
    name: "totalhr",
    description: "Show total hours of all users (Manager only)",
    options: [
      {
        name: "start",
        type: 3,
        description: "Start date (MM/DD/YYYY)",
        required: false,
      },
      {
        name: "end",
        type: 3,
        description: "End date (MM/DD/YYYY)",
        required: false,
      },
    ],
  },
  {
    name: "total",
    description: "Show total topup amount for this freecash thread (Manager only)",
  },
  {
    name: "forceclockout",
    description: "Force clock-out a user (Manager only)",
    options: [
      {
        name: "user",
        type: 6,
        description: "User to force clock-out",
        required: true,
      },
    ],
  },
  {
    name: "timesheet",
    description: "View timesheets",
    options: [
      {
        type: 1,
        name: "view",
        description: "View a user's timesheet",
        options: [
          {
            name: "user",
            type: 6,
            description: "User to view",
            required: false,
          },
          {
            name: "start",
            type: 3,
            description: "Start date (MM/DD/YYYY)",
            required: false,
          },
          {
            name: "end",
            type: 3,
            description: "End date (MM/DD/YYYY)",
            required: false,
          },
        ],
      },
    ],
  },
  {
    name: "edit",
    description: "Edit or delete a user's session (Manager only)",
    options: [
      {
        name: "user",
        type: 6,
        description: "User whose session you want to edit",
        required: true,
      },
      {
        name: "session",
        type: 4,
        description: "Session number (1,2,3...)",
        required: true,
      },
      {
        name: "started",
        type: 3,
        description: "New start time (HH:MM or 0)",
        required: true,
      },
      {
        name: "ended",
        type: 3,
        description: "New end time (HH:MM or 0)",
        required: true,
      },
    ],
  },
];

const rest = new REST({ version: "10" }).setToken(TOKEN);

(async () => {
  try {
    console.log(`🚀 Deploying ${commands.length} commands...`);

    await rest.put(
      Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
      { body: commands }
    );

    console.log("✅ Commands deployed successfully.");
  } catch (err) {
    console.error("❌ Command deployment failed:", err);
  }
})();
