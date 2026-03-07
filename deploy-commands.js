import { REST, Routes } from "discord.js";
import dotenv from "dotenv";
import { slashCommands } from "./slash-commands.js";

dotenv.config();

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

const rest = new REST({ version: "10" }).setToken(TOKEN);

(async () => {
  try {
    console.log(`🚀 Deploying ${slashCommands.length} commands...`);

    await rest.put(
      Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
      { body: slashCommands }
    );

    console.log("✅ Commands deployed successfully.");
  } catch (err) {
    console.error("❌ Command deployment failed:", err);
  }
})();
