/**
 * Test-only setup: override HOME with a throwaway dir BEFORE any module
 * under test is evaluated. parser.ts computes DEFAULT_SESSION_DIR /
 * DEFAULT_ARCHIVE_DIR from process.env.HOME at module load; without this,
 * index tests would scan (and slowly embed) the real production sessions.
 *
 * MUST be the first import of the test file (ESM evaluates imports in
 * source order). Each test file runs in its own process under node --test,
 * so the override never leaks into other suites.
 */
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";

process.env.HOME = mkdtempSync(join(tmpdir(), "om-test-home-"));
