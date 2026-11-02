/** Gmail raw MIME message, with UTF-8 subject/body and no user-controlled extra headers. */
export function buildEmailMessage(to: string, subject: string, message: string) {
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
  return Buffer.from([`To: ${to.trim()}`, `Subject: ${encodedSubject}`, "MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64", "", encodedBody].join("\r\n"), "utf8").toString("base64url");
}
