import fs from "fs/promises";
import path from "path";
import crypto from "crypto";

async function main() {
  const binaryPath = process.argv[2];
  const manifestPath = process.argv[3] || "release/latest.json";

  if (!binaryPath) {
    console.error("Usage: node scripts/generate-checksum.js <binaryPath> [manifestPath]");
    process.exit(1);
  }

  const fileBuffer = await fs.readFile(binaryPath);
  const sha256 = crypto.createHash("sha256").update(fileBuffer).digest("hex");

  const pkg = JSON.parse(await fs.readFile("package.json", "utf8"));
  const version = pkg.version;
  const tag = `v${version}`;
  const fileName = path.basename(binaryPath);
  const owner = process.env.GH_OWNER || "<owner>";
  const repo = process.env.GH_REPO || "<repo>";

  const manifest = {
    version,
    tag,
    asset: fileName,
    sha256,
    url: `https://github.com/${owner}/${repo}/releases/download/${tag}/${fileName}`
  };

  await fs.mkdir(path.dirname(manifestPath), { recursive: true });
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  await fs.writeFile("release/checksums.txt", `${sha256}  ${fileName}\n`);

  console.log(`Generated ${manifestPath}`);
  console.log(`SHA256 ${fileName}: ${sha256}`);
}

main().catch((err) => {
  console.error("Failed to generate checksum manifest:", err);
  process.exit(1);
});
