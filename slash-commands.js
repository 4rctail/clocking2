export const slashCommands = [
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
    name: "topup",
    description: "Record a topup entry for this channel/thread",
    options: [
      {
        name: "entry",
        type: 3,
        description: "Topup text, e.g. 20$ | 333 cvv | troy | 5244",
        required: true,
      },
    ],
  },
  {
    name: "total",
    description: "Show total topup amount for this channel (Manager only)",
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
        description: "View a user's timesheet or fetch strict nightshift matches",
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
          {
            name: "nightshift_start",
            type: 3,
            description: "Nightshift start (HH:MM, e.g. 00:00)",
            required: false,
          },
          {
            name: "nightshift_end",
            type: 3,
            description: "Nightshift end (HH:MM, e.g. 05:00)",
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
