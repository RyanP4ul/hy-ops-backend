import { Elysia, t } from "elysia";

export const geocodeRoute = new Elysia({
  prefix: "/geocode",
}).get(
  "/search",
  async ({ query, status }) => {
    const search = query.q.trim();

    if (search.length < 3) {
      return [];
    }

    if (search.length > 200) {
      return status(400, {
        message: "Search query must not exceed 200 characters",
      });
    }

    const url = new URL("https://nominatim.openstreetmap.org/search");

    url.searchParams.set("q", `${search}, Philippines`);
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("addressdetails", "1");
    url.searchParams.set("limit", "5");
    url.searchParams.set("countrycodes", "ph");
    url.searchParams.set("accept-language", "en");

    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent": `HYOps/1.0 (${process.env.NOMINATIM_CONTACT ?? "contact-not-configured"})`,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(8000),
      });

      if (!response.ok) {
        console.error("Nominatim returned status:", response.status);

        return status(502, {
          message: "Geocoding service unavailable",
        });
      }

      const data = await response.json();

      return data;
    } catch (error) {
      console.error("Geocoding error:", error);

      return status(502, {
        message: "Failed to search address",
      });
    }
  },
  {
    query: t.Object({
      q: t.String({ minLength: 1, maxLength: 250 }),
    }),
  },
);
