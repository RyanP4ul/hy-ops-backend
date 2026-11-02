import { z } from "zod";
import { WorkflowError } from "../../utils/workflow-error";

const total = z.number().int().nonnegative();
const statsSchema = z.object({
  success: z.literal(true),
  overall: z.object({ total, pending: total, processing: total, sent: total, delivered: total, failed: total, cancelled: total }),
  today: z.object({ total, sent: total, failed: total }),
  weekly_trend: z.array(z.object({ date: z.string(), total, sent: total, failed: total })),
  per_device: z.array(z.object({ device_id: z.string(), device_name: z.string(), is_active: z.boolean(), last_seen: z.string().nullable(), total_sms: total, sent: total, failed: total })),
  active_devices: total,
});
const templatesSchema = z.object({ success: z.literal(true), templates: z.array(z.object({
  id: z.number().int().positive(), name: z.string(), content: z.string(), variables: z.array(z.string()),
  is_active: z.boolean(), usage_count: total, created_at: z.string(),
})) });
export type SmsCommand = { device_id: string; phone_number: string | number; message?: string; template_id?: number; variables?: Record<string, unknown>; priority?: number; sim_slot?: number; scheduled_at?: string; webhook_url?: string };

export function templateVariables(content: string, declared: string[]) {
  return [...new Set([...declared, ...Array.from(content.matchAll(/{{\s*([\w.-]+)\s*}}/g), match => match[1])])];
}

export class SmsGateway {
  constructor(private readonly transport: typeof fetch = fetch, private readonly config?: { url: string; token: string }) {}
  private async request(path: string, body?: SmsCommand): Promise<Record<string, unknown>> {
    const base = this.config?.url ?? process.env.API_SMS_URL;
    const token = this.config?.token ?? process.env.SMS_ADMIN_KEY;
    if (!base || !token) throw new WorkflowError("SMS gateway is not configured. Contact your administrator.", 503);
    let url: URL;
    try { url = new URL(`${base.replace(/\/+$/, "")}${path}`); if (!["http:", "https:"].includes(url.protocol)) throw new Error(); }
    catch { throw new WorkflowError("SMS gateway configuration is invalid. Contact your administrator.", 503); }
    let response: Response;
    try {
      response = await this.transport(url.toString(), { method: body ? "POST" : "GET",
        headers: { "Content-Type": "application/json", "x-admin-token": token },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000) });
    } catch {
      throw new WorkflowError(body ? "Unable to confirm SMS submission. Check your SMS gateway before sending again." : "Unable to reach the SMS gateway. Please try again.", 502);
    }
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw new WorkflowError("SMS gateway authentication failed. Contact your administrator.", 502);
      if (response.status === 429) throw new WorkflowError("SMS gateway limit reached. Please try later.", 429);
      throw new WorkflowError(body ? "SMS gateway rejected the request. Check the recipient, template and device before retrying." : "SMS gateway is temporarily unavailable.", response.status >= 500 ? 502 : 400);
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload) || !("success" in payload) || payload.success !== true) {
      throw new WorkflowError(body ? "SMS submission was not confirmed. Check your SMS gateway before sending again." : "SMS gateway returned an invalid response.", 502);
    }
    return payload as Record<string, unknown>;
  }
  async stats() {
    const parsed = statsSchema.safeParse(await this.request("/stats"));
    if (!parsed.success) throw new WorkflowError("SMS gateway statistics are unavailable. Please try again.", 502);
    return parsed.data;
  }
  async templates() {
    const parsed = templatesSchema.safeParse(await this.request("/templates"));
    if (!parsed.success) throw new WorkflowError("SMS gateway templates are unavailable. Please try again.", 502);
    return parsed.data;
  }
  async send(input: SmsCommand) {
    const phone = String(input.phone_number).replace(/[\s()-]/g, "");
    if (!/^\+?\d{7,15}$/.test(phone)) throw new WorkflowError("Enter a valid phone number, including country code when needed.", 400);
    if (!input.device_id.trim()) throw new WorkflowError("Choose an SMS device.", 400);
    const stats = await this.stats();
    if (!stats.per_device.some(device => device.device_id === input.device_id && device.is_active)) throw new WorkflowError("The selected SMS device is no longer active. Refresh and choose a device.", 409);
    if (input.template_id !== undefined) {
      const { templates } = await this.templates();
      const template = templates.find(item => item.id === input.template_id && item.is_active);
      if (!template) throw new WorkflowError("The selected SMS template is unavailable. Refresh and choose an active template.", 409);
      for (const name of templateVariables(template.content, template.variables)) {
        const value = input.variables?.[name];
        if (!((typeof value === "string" && value.trim()) || (typeof value === "number" && Number.isFinite(value)))) throw new WorkflowError(`Complete the template variable: ${name}.`, 400);
      }
    } else if (!input.message?.trim()) throw new WorkflowError("A template or message is required.", 400);
    const payload = await this.request("/sms/send", { ...input, phone_number: phone });
    return { success: true, message: "SMS request accepted by the gateway. Delivery is tracked by your SMS gateway.",
      ...(typeof payload.id === "string" || typeof payload.id === "number" ? { id: payload.id } : {}) };
  }
}
