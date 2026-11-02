CREATE TABLE vehicle_positions (
  vehicle_id integer PRIMARY KEY REFERENCES vehicles(id) ON DELETE CASCADE,
  longitude double precision NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  latitude double precision NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  speed_kph double precision, heading double precision, accuracy_m double precision,
  sample_interval_seconds double precision,
  recorded_at timestamptz NOT NULL, received_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE payment_receipts (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  payment_id integer NOT NULL REFERENCES payments(id) ON DELETE RESTRICT,
  amount numeric(12,2) NOT NULL CHECK (amount > 0),
  kind text NOT NULL DEFAULT 'receipt' CHECK (kind IN ('receipt', 'legacy_aggregate')),
  received_at timestamptz NOT NULL
);
--> statement-breakpoint
CREATE INDEX payment_receipts_payment_date_idx ON payment_receipts(payment_id, received_at);
