import Elysia, { t } from "elysia";

const Phone = t.Union([t.String(), t.Number()]);
const Variables = t.Optional(t.Record(t.String(), t.Any()));

const smsSend = t.Object({
  device_id: t.String(),
  phone_number: Phone,
  message: t.Optional(t.String()),
  priority: t.Optional(t.Numeric()),
  sim_slot: t.Optional(t.Numeric()),
  scheduled_at: t.Optional(t.String()),
  webhook_url: t.Optional(t.String()),
  template_id: t.Optional(t.Numeric()),
  variables: Variables,
});

export const smsModel = new Elysia().model({
  "sms.send": smsSend,
});
