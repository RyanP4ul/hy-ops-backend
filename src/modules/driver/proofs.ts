import { and, asc, count, eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { db } from "../../db";
import { deliveries, deliveries_stops, driver_stop_proofs } from "../../db/schema";
import { r2, r2Bucket } from "../../lib/storage/r2";
import { WorkflowError } from "../../utils/workflow-error";
import { staffWarehouse, assertDeliveryScope } from "../deliveries/scope";

export interface ProofStorage {
  put(key: string, data: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<Uint8Array>;
  delete(key: string): Promise<void>;
}
const storage: ProofStorage = {
  async put(key, data, contentType) { await r2.send(new PutObjectCommand({ Bucket: r2Bucket, Key: key, Body: data, ContentType: contentType })); },
  async get(key) { const value = await r2.send(new GetObjectCommand({ Bucket: r2Bucket, Key: key })); if (!value.Body) throw new WorkflowError("Proof file is unavailable.", 404); return value.Body.transformToByteArray(); },
  async delete(key) { await r2.send(new DeleteObjectCommand({ Bucket: r2Bucket, Key: key })); },
};
type Actor = { sub: unknown; role: unknown };
const metadata = { id: driver_stop_proofs.id, kind: driver_stop_proofs.kind, contentType: driver_stop_proofs.content_type, byteSize: driver_stop_proofs.byte_size, createdAt: driver_stop_proofs.created_at };

export class ProofService {
  constructor(private readonly store: ProofStorage = storage) {}

  private async authorize(actor: Actor, stopId: number) {
    const [row] = await db.select({ run: deliveries }).from(deliveries_stops).innerJoin(deliveries, eq(deliveries.id, deliveries_stops.delivery_id)).where(eq(deliveries_stops.id, stopId));
    if (!row) throw new WorkflowError("Assignment not found.", 404);
    if (actor.role === "driver") {
      if (row.run.driver_id !== Number(actor.sub)) throw new WorkflowError("Assignment not found.", 404);
    } else await assertDeliveryScope(db, row.run.id, await staffWarehouse(actor));
    return row.run;
  }

  async list(actor: Actor, stopId: number) {
    await this.authorize(actor, stopId);
    return db.select(metadata).from(driver_stop_proofs).where(eq(driver_stop_proofs.stop_id, stopId)).orderBy(asc(driver_stop_proofs.created_at), asc(driver_stop_proofs.id));
  }

  async download(actor: Actor, stopId: number, id: string) {
    await this.authorize(actor, stopId);
    const [proof] = await db.select().from(driver_stop_proofs).where(and(eq(driver_stop_proofs.id, id), eq(driver_stop_proofs.stop_id, stopId)));
    if (!proof) throw new WorkflowError("Proof not found.", 404);
    const bytes = await this.store.get(proof.storage_key);
    return new Response(bytes as BodyInit, { headers: { "Content-Type": proof.content_type, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Content-Disposition": `inline; filename="${proof.id}.${proof.kind === "signature" ? "png" : "webp"}"` } });
  }

  async upload(actorId: number, stopId: number, file: File, kind: "photo" | "signature", operationKey: string) {
    if (!file.size || file.size > 5 * 1024 * 1024) throw new WorkflowError("Proof must be between 1 byte and 5 MB.", 400);
    let data: Buffer;
    try {
      const image = sharp(Buffer.from(await file.arrayBuffer()), { limitInputPixels: 20000000, animated: false });
      const info = await image.metadata();
      if (!["jpeg", "png", "webp"].includes(info.format ?? "") || (info.pages ?? 1) > 1) throw new Error("Invalid image");
      const normalized = image.rotate().resize({ width: 2048, height: 2048, fit: "inside", withoutEnlargement: true });
      data = kind === "signature" ? await normalized.png().toBuffer() : await normalized.webp({ quality: 85 }).toBuffer();
    } catch { throw new WorkflowError("Upload a valid JPEG, PNG, or WebP image.", 400); }
    if (data.length > 5 * 1024 * 1024) throw new WorkflowError("Normalized proof exceeds the 5 MB limit.", 400);
    const hash = createHash("sha256").update(data).digest("hex");
    const contentType = kind === "signature" ? "image/png" : "image/webp";
    let written: string | undefined;
    try {
      return await db.transaction(async tx => {
        const [identity] = await tx.select({ deliveryId: deliveries_stops.delivery_id }).from(deliveries_stops).where(eq(deliveries_stops.id, stopId));
        if (!identity) throw new WorkflowError("Assignment not found.", 404);
        const [run] = await tx.select().from(deliveries).where(eq(deliveries.id, identity.deliveryId)).for("update");
        if (!run || run.driver_id !== actorId) throw new WorkflowError("Assignment not found.", 404);
        const [existing] = await tx.select().from(driver_stop_proofs).where(eq(driver_stop_proofs.operation_key, operationKey));
        if (existing) {
          if (existing.actor_id !== actorId || existing.stop_id !== stopId || existing.sha256 !== hash || existing.kind !== kind) throw new WorkflowError("Proof operation key was already used for another upload.");
          return { id: existing.id, kind: existing.kind, contentType: existing.content_type, byteSize: existing.byte_size, createdAt: existing.created_at };
        }
        if (!["in_transit", "returning", "completed"].includes(run.status)) throw new WorkflowError("Proofs require a dispatched assignment.");
        const [amount] = await tx.select({ total: count() }).from(driver_stop_proofs).where(and(eq(driver_stop_proofs.stop_id, stopId), eq(driver_stop_proofs.kind, kind)));
        if (amount.total >= (kind === "signature" ? 1 : 3)) throw new WorkflowError("This stop already has the maximum proofs of this kind.");
        const id = crypto.randomUUID(), key = `driver-proofs/${id}`;
        written = key;
        await this.store.put(key, data, contentType);
        const [record] = await tx.insert(driver_stop_proofs).values({ id, stop_id: stopId, actor_id: actorId, operation_key: operationKey, kind, storage_key: key, content_type: contentType, sha256: hash, byte_size: data.length }).returning(metadata);
        return record;
      });
    } catch (error) {
      if (written) { try { await this.store.delete(written); } catch { console.error("Driver proof cleanup failed; private orphan requires storage cleanup."); } }
      throw error;
    }
  }
}
export const proofService = new ProofService();
