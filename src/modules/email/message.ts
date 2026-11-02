/** Gmail raw MIME message, with UTF-8 subject/body and no user-controlled extra headers. */
export function buildEmailMessage(to: string, subject: string, message: string, attachment?: { filename: string; contentType: string; content: string | Uint8Array }) {
  if (/[\r\n]/.test(to) || /[\r\n]/.test(subject)) throw new Error("Invalid email headers.");
  const words: string[] = [];
  let chunk = "";
  for (const char of subject.trim()) {
    if (Buffer.byteLength(chunk + char, "utf8") > 42) { words.push(chunk); chunk = ""; }
    chunk += char;
  }
  if (chunk) words.push(chunk);
  const encodedSubject = words.map(word => `=?UTF-8?B?${Buffer.from(word).toString("base64")}?=`).join("\r\n ");
  const encodedBody = Buffer.from(message, "utf8").toString("base64").match(/.{1,76}/g)?.join("\r\n") ?? "";
  const headers = [`To: ${to.trim()}`, `Subject: ${encodedSubject}`, "MIME-Version: 1.0"];
  if (!attachment) return Buffer.from([...headers, "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64", "", encodedBody].join("\r\n"), "utf8").toString("base64url");
  if (!/^[a-zA-Z0-9_.-]+$/.test(attachment.filename) || !/^[a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+$/.test(attachment.contentType)) throw new Error("Invalid attachment headers.");
  const boundary = `hyops_${crypto.randomUUID()}`;
  const attachmentBytes = typeof attachment.content === "string" ? Buffer.from(attachment.content, "utf8") : Buffer.from(attachment.content);
  const encodedAttachment = attachmentBytes.toString("base64").match(/.{1,76}/g)?.join("\r\n") ?? "";
  return Buffer.from([...headers, `Content-Type: multipart/mixed; boundary="${boundary}"`, "",
    `--${boundary}`, "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64", "", encodedBody,
    `--${boundary}`, `Content-Type: ${attachment.contentType}; name="${attachment.filename}"`,
    `Content-Disposition: attachment; filename="${attachment.filename}"`, "Content-Transfer-Encoding: base64", "", encodedAttachment,
    `--${boundary}--`, ""].join("\r\n"), "utf8").toString("base64url");
}
