import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { DeleteObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { r2, r2Bucket } from "../../../lib/storage/r2";
import { DeliveryService } from "../../deliveries/service";

const MAX_FILE_SIZE = 5 * 1024 * 1024;

const ALLOWED_FORMATS = new Set(["jpeg", "png", "webp", "avif"]);

export async function uploadImage(driver_id: number, file: File) {
  if (file.size === 0 || file.size > MAX_FILE_SIZE) {
    throw new Error("Image must be between 1 byte and 5 MB.");
  }

  const input = Buffer.from(await file.arrayBuffer());

  // Inspect the actual image contents, not just file.type.
  const image = sharp(input, {
    limitInputPixels: 20_000_000,
    failOn: "error",
  });

  const metadata = await image.metadata();

  if (!metadata.format || !ALLOWED_FORMATS.has(metadata.format)) {
    throw new Error("Only JPEG, PNG, WebP, and AVIF images are allowed.");
  }

  if (!metadata.width || !metadata.height) {
    throw new Error("Invalid image dimensions.");
  }

  const output = await image.rotate().webp({ quality: 82 }).toBuffer();

  const key = `deliveries_proof/${randomUUID()}.webp`;

  await r2.send(
    new PutObjectCommand({
      Bucket: r2Bucket,
      Key: key,
      Body: output,
      ContentType: "image/webp",
      CacheControl: "private, max-age=3600",
    }),
  );

  await DeliveryService.createDeliveryProof(driver_id, key);

  return {
    key,
    contentType: "image/webp",
    size: output.length,
    width: metadata.width,
    height: metadata.height,
  };
}

export async function deleteProductImage(key: string) {
  // Never allow arbitrary object keys from the client.
  if (!/^products\/[0-9a-f-]+\.webp$/i.test(key)) {
    throw new Error("Invalid product image key.");
  }

  await r2.send(
    new DeleteObjectCommand({
      Bucket: r2Bucket,
      Key: key,
    }),
  );
}
