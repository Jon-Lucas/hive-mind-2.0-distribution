import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { z } from "zod";
import {
  ATTACHMENT_MIME_EXTENSIONS,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_MESSAGE,
  type BrainService,
} from "../../conversation/brain-service.js";
import { WorkflowConflictError } from "../../workflow/workflow-service.js";

/** Server-issued names only: a UUID plus a known image extension. */
const STORED_FILE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|webp|gif)$/;

const attachmentRef = z.object({
  file: z.string().regex(STORED_FILE_PATTERN, "unknown attachment reference"),
  name: z.string().trim().min(1).max(200),
  mime: z.enum(Object.keys(ATTACHMENT_MIME_EXTENSIONS) as [string, ...string[]]),
}).strict();

const messageSchema = z.object({
  text: z.string().trim().max(50_000).default(""),
  attachments: z.array(attachmentRef).max(MAX_ATTACHMENTS_PER_MESSAGE).default([]),
}).strict();

const uploadSchema = z.object({
  name: z.string().trim().min(1).max(200),
  mime: z.enum(Object.keys(ATTACHMENT_MIME_EXTENSIONS) as [string, ...string[]]),
  /** Base64 file content, no data-URL prefix. */
  data: z.string().min(1),
}).strict();

export interface ConversationRouteOptions {
  /** Directory for uploaded reference images. Omit to disable attachments. */
  attachmentsRoot?: string;
}

export async function registerConversationRoutes(
  app: FastifyInstance,
  brain: BrainService,
  options: ConversationRouteOptions = {},
): Promise<void> {
  app.get("/api/brain/messages", async () => brain.listMessages());

  app.post("/api/brain/messages", async (request) => {
    const { text, attachments } = messageSchema.parse(request.body);
    if (!text && attachments.length === 0) throw new WorkflowConflictError("Invalid message: text or an attachment is required");
    if (attachments.length > 0) {
      if (!options.attachmentsRoot) throw new WorkflowConflictError("Invalid message: attachments are not configured on this server");
      // The reference must point at a file this server actually wrote:
      // a stale id would otherwise reach Brain as a path that fails to Read.
      for (const attachment of attachments) {
        if (!fs.existsSync(path.join(options.attachmentsRoot, attachment.file))) {
          throw new WorkflowConflictError(`Invalid message: attachment ${attachment.name} was not uploaded`);
        }
      }
    }
    return brain.send("gui", text, attachments);
  });

  if (!options.attachmentsRoot) return;
  const attachmentsRoot = options.attachmentsRoot;
  fs.mkdirSync(attachmentsRoot, { recursive: true });

  app.post("/api/brain/attachments", async (request) => {
    const { name, mime, data } = uploadSchema.parse(request.body);
    const bytes = Buffer.from(data, "base64");
    if (bytes.length === 0) throw new WorkflowConflictError("Invalid attachment: file is empty");
    if (bytes.length > MAX_ATTACHMENT_BYTES) {
      throw new WorkflowConflictError(`Invalid attachment: exceeds ${Math.floor(MAX_ATTACHMENT_BYTES / (1024 * 1024))}MB`);
    }
    const file = `${crypto.randomUUID()}${ATTACHMENT_MIME_EXTENSIONS[mime]}`;
    fs.writeFileSync(path.join(attachmentsRoot, file), bytes);
    return { file, name, mime, url: `/api/brain/attachments/${file}` };
  });

  // Serving via fastify-static keeps content types and range requests correct;
  // the UUID pattern on stored names is what rules out traversal.
  await app.register(fastifyStatic, {
    root: attachmentsRoot,
    prefix: "/api/brain/attachments/",
    decorateReply: false,
    cacheControl: false,
    setHeaders: (reply) => {
      void reply.header("cache-control", "no-store");
    },
  });
}
