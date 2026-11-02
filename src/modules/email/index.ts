import { Elysia, t } from "elysia";
import { buildEmailMessage } from "./message";
import { gmail, oauth2Client } from "../../lib/gmail";

export type EmailSender = (raw: string) => Promise<string | undefined>;
const gmailSender: EmailSender = async raw => (await gmail.users.messages.send({ userId: "me", requestBody: { raw } }, { timeout: 15000, retry: false })).data.id ?? undefined;
export function createEmailRoutes(sender: EmailSender = gmailSender) { return new Elysia({
  prefix: "/email",
})
  .get("/oauth/start", ({ redirect }) => {
    if (process.env.NODE_ENV === "production")
      return new Response("OAuth setup is unavailable in production.", {
        status: 404,
      });
    const url = oauth2Client.generateAuthUrl({
      access_type: "offline",
      scope: ["https://www.googleapis.com/auth/gmail.send"],
      prompt: "consent",
    });

    return redirect(url);
  })

  .get("/oauth/callback", async ({ query, set }) => {
    if (process.env.NODE_ENV === "production") {
      set.status = 404;
      return { message: "OAuth setup is unavailable in production." };
    }
    const code = query.code;

    if (!code) {
      set.status = 400;
      return { message: "Missing authorization code" };
    }

    const { tokens } = await oauth2Client.getToken(code);

    if (!tokens.refresh_token) {
      set.status = 400;

      return {
        message: "No refresh token returned. Reauthorize the Google account.",
      };
    }

    // Development only:
    // Copy this token into your backend .env file.
    // Never return it to the browser in production.
    return {
      message: "Google authorization successful.",
      refreshToken: tokens.refresh_token,
    };
  })
  .get("/test", async () => {
    const response = await gmail.users.getProfile({
      userId: "me",
    });

    return {
      success: true,
      email: response.data.emailAddress,
    };
  })
  .post(
    "/send",
    async ({ body, set }) => {
      const { to, subject, message } = body;

      if (
        typeof to !== "string" ||
        typeof subject !== "string" ||
        typeof message !== "string" ||
        !to.trim() ||
        !subject.trim() ||
        !message.trim()
      ) {
        set.status = 400;

        return {
          message: "Recipient, subject, and message are required.",
        };
      }

      const encodedMessage = buildEmailMessage(to, subject, message);

      try {
        const messageId = await sender(encodedMessage);
        if (!messageId) throw new Error("Missing send acknowledgement");

        return {
          success: true,
          message: "Email sent successfully.",
          messageId,
        };
      } catch {
        console.error("Gmail send was not confirmed.");

        set.status = 502;

        return {
          success: false,
          message: "Unable to confirm email submission. Check the sender mailbox before sending again.",
        };
      }
    },
    {
      body: t.Object({
        to: t.String({ format: "email", pattern: "^[^\\r\\n]+$" }),
        subject: t.String({ minLength: 1, maxLength: 200, pattern: "^[^\\r\\n]+$" }),
        message: t.String({ minLength: 1, maxLength: 20000 }),
      }),
    },
  );

}
export const emailRoutes = createEmailRoutes();
