import { z } from "zod";

export const agentTypeSchema = z.enum(["claude", "codex"]);

export const createRepoSchema = z.object({
  name: z.string().min(1).max(200),
  path: z.string().trim().min(1),
});

export const createSessionSchema = z.object({
  repoId: z.string().min(1),
  agent: agentTypeSchema,
  cwd: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
});


export const workspaceRootSchema = z.object({
  rootPath: z.string().trim().min(1),
});
