import { randomUUID } from "crypto";
import { mkdir, writeFile } from "fs/promises";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import path from "node:path";
import { requireAuth } from "../middleware/auth";

const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Map<string, string>([
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/gif", "gif"],
  ["image/webp", "webp"],
]);

const uploadsRoute = new Hono();

uploadsRoute.use("*", requireAuth);

uploadsRoute.post("/", async (c) => {
  const body = await c.req.parseBody().catch(() => null);
  if (!body || typeof body !== "object") {
    throw new HTTPException(400, { message: "Invalid form data" });
  }

  const file = (body as Record<string, unknown>)["file"];

  if (!(file instanceof File)) {
    throw new HTTPException(400, { message: "File is required" });
  }

  const extension = ALLOWED_IMAGE_TYPES.get(file.type);
  if (!extension) {
    throw new HTTPException(400, { message: "Only image files are allowed" });
  }

  if (file.size > MAX_FILE_SIZE_BYTES) {
    throw new HTTPException(400, { message: "File must be 10MB or less" });
  }

  const uploadDir = path.resolve("uploads");
  await mkdir(uploadDir, { recursive: true });

  const filename = `${randomUUID()}.${extension}`;
  const filePath = path.join(uploadDir, filename);
  const buffer = Buffer.from(await file.arrayBuffer());
  await writeFile(filePath, buffer);

  return c.json({ url: `/uploads/${filename}` });
});

export default uploadsRoute;
