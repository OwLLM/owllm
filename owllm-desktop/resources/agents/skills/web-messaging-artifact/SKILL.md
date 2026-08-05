---
name: Web Messaging Artifact
description: Send an image, screenshot, document, or other file through a web-based messaging service such as WhatsApp Web, Telegram Web, Messenger, LINE, or WeChat Web.
triggers:
  - whatsapp
  - telegram
  - messenger
  - line
  - wechat
  - screenshot
  - capture
  - attach
  - upload
  - document
  - file
---

# Web Messaging Artifact

You send an image, screenshot, document, or other file through a web-based messaging service. Work directly in the shared browser; do not plan, delegate, or ask for permission unless a required detail is genuinely missing.

## Before you act
1. Confirm the service the user wants (WhatsApp Web, Telegram Web, etc.) and the recipient or chat.
2. Identify the file to send. If the user only asked to capture without sending, use `browser_screenshot` and stop after confirming the capture.
3. If no file path is given and a screenshot is implied, capture it yourself with `browser_screenshot`.

## Procedure
1. Open the messaging service in the shared browser with `browser_open` if it is not already open.
2. Navigate to the correct chat. Use the service's search if needed; stop and ask only if the recipient cannot be found.
3. Attach the file:
   - Use `browser_upload_file` to attach the file directly to the service's file input. This works for WhatsApp Web, Telegram Web, Messenger, LINE, and WeChat Web without opening an OS picker.
   - Prefer sending images/screenshots as a **Document** (not a photo/video) when the service offers the choice, so readable text is not recompressed.
4. Verify the attachment filename and recipient, then send.
5. Confirm success from the UI (sent checkmark, delivered indicator, etc.) and report the result concisely.

## Call budget
- Open/navigate: ≤ 3 browser calls.
- Capture (if needed): 1 `browser_screenshot` call.
- Attach + send: ≤ 2 calls (`browser_upload_file`, then click send).
- If you are stuck for more than two recovery rounds, stop and tell the user exactly what is blocked.

## Recovery
- If the upload control is not visible, snapshot the page to see the current state, then look for a paperclip, plus, or attach icon.
- If the service shows a login/QR screen, report it and stop; do not attempt credential entry.
- If the file is too large for the service, compress or resize the image before retrying.

## Success criteria
- Recipient/chat is correct.
- File is attached with its original filename visible.
- Message shows as sent/delivered.
- User receives a one-line summary of what was sent and to whom.
