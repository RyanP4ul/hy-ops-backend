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

    const url = new URL("https://nominatim.openstreetmap.org/search");

    url.searchParams.set("q", `${search}, Philippines`);
    url.searchParams.set("format", "json");
    url.searchParams.set("addressdetails", "1");
    url.searchParams.set("limit", "5");
    url.searchParams.set("countrycodes", "ph");

    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent": "HYOps/1.0",
          Accept: "application/json",
        },
      });

      if (!response.ok) {
        return status(502, {
          message: "Geocoding service unavailable",
        });
      }

      const data = await response.json();

      return data;
    } catch (error) {
      console.error("Geocoding error:", error);

      return status(500, {
        message: "Failed to search address",
      });
    }
  },
  {
    query: t.Object({
      q: t.String(),
    }),
  },
);
