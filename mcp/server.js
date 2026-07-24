'use strict';

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { McpError } = require('@modelcontextprotocol/sdk/types.js');
const { z } = require('zod');
const { apiRequest, createTracklyAccessError, hasAuth, maintenanceOutput } = require('../lib/client');
const { prepareResume, verifyPreparedResume } = require('../lib/agent');
const { version: PACKAGE_VERSION } = require('../package.json');
const APPLY_CONTRACT = require('../contracts/trackly-apply-tools.json');

const MCP_USER_AGENT = `trackly-mcp/${PACKAGE_VERSION}`;
const MCP_MAINTENANCE_ERROR_CODE = -32002;
const MCP_ACCESS_ERROR_CODE = -32003;
const MCP_AUTH_ERROR_CODE = -32004;
const AUTH_HINT =
  'Existing members: run `trackly login` or set TRACKLY_API_KEY. ' +
  'New members need a private invite during the limited rollout; request access at https://usetrackly.app/early-access.';
const APPLY_BROWSER_SURFACES = APPLY_CONTRACT.constants.applyBrowserSurfaces;
const APPLY_SCENARIO_CODES = APPLY_CONTRACT.constants.applyScenarioCodes;
const APPLY_CHECKPOINT_ACTION_CODES = APPLY_CONTRACT.constants.applyCheckpointActionCodes;
const APPLY_CHECKPOINT_PACKET_PHASES = APPLY_CONTRACT.constants.applyCheckpointPacketPhases;
const SAFE_OBSERVATION_CODE = /^[a-z0-9][a-z0-9_:-]{0,99}$/;
const SAFE_IDEMPOTENCY_KEY = /^[\x20-\x7e]+$/;

// Mirrors `granola-followup-app/src/services/region-classifier.ts:8` REGION_TAGS.
// Keep in sync when the backend enum changes.
const REGION_TAGS = [
  'us', 'europe', 'latam', 'middle_east', 'asia', 'africa', 'canada', 'oceania', 'remote', 'unknown',
];

// REGION_TAGS values that are safe to combine in a comma-list with other tags.
// `us` is excluded because combining it with other tags (e.g. ['us', 'europe']) is a trap:
// the backend parser at granola-followup-app/src/routes/jobscout-filter-utils.ts:73-90
// supports `us` ONLY as a single-value scalar; in a comma-list it behaves identically to
// the scalar branch and any non-us members are ignored. Callers who want 'us + europe' should
// use the scalar `all` or two separate calls. Callers who want 'not us' should use `non_us`.
const REGION_TAGS_ARRAY_SAFE = REGION_TAGS.filter((t) => t !== 'us');

// `jobFunction` enum matches `granola-followup-app/src/routes/jobscout-filter-utils.ts:17-21`
// (ALL_JOB_FUNCTIONS). 14 canonical values.
const JOB_FUNCTIONS = [
  'product', 'engineering', 'design', 'data', 'marketing', 'sales', 'partnerships',
  'finance', 'strategy', 'operations', 'people', 'legal', 'support', 'other',
];

// Public canonical states. The backend privately accepts retired aliases for
// old clients, but new MCP clients must never emit them.
const STATUS_VALUES = ['new', 'applied_confirmed', 'check_later', 'not_interested', 'all'];

// `jobModality` enum matches `jobscout.ts:2870-2875`. Employment type, NOT work-location.
const JOB_MODALITIES = ['full_time', 'internship', 'all'];

// Independent from geography and employment type. Matches the backend's
// workArrangements query contract and job_postings constraint.
const WORK_ARRANGEMENTS = ['remote', 'hybrid', 'in_person', 'unspecified'];

// `sort` enum matches backend handler at `jobscout.ts:3053` — NOT the pre-fix
// `newest|oldest|company` (backend rejects oldest/company with HTTP 400).
const SORT_VALUES = ['newest', 'match'];

// Maps the user-facing trackly_update_status action to the backend's tracker
// stage column. Backend `/api/jobscout/tracker/jobs/:id/stage` expects the
// stage value, NOT the legacy action name. Hoisted to module scope so it's not
// rebuilt on every tool invocation.
const ACTION_TO_STAGE = { applied: 'applied', saved: 'backlog', dismissed: 'discarded' };

function createErrorResult(error, fallbackMessage, extra = {}) {
  const normalizedMaintenance = maintenanceOutput(error);
  const normalizedAccess = createTracklyAccessError(error, error?.status);
  const payload = normalizedMaintenance
    ? {
        ...normalizedMaintenance,
        error: error?.error || error?.message || fallbackMessage,
        ...extra,
      }
    : normalizedAccess
      ? {
          error: normalizedAccess.error,
          message: normalizedAccess.message,
          status: normalizedAccess.status,
          code: normalizedAccess.code,
          retryable: normalizedAccess.retryable,
          ...extra,
        }
      : {
          error: error?.error || error?.message || fallbackMessage,
          ...extra,
        };

  if (error?.status) {
    payload.status = error.status;
  }

  if (
    error?.code === 'experience_filter_v2_unavailable'
    || error?.code === 'invalid_preference_revision'
  ) {
    payload.code = error.code;
  }

  if (error?.status === 409 && error?.error === 'preference_revision_conflict') {
    payload.preferences = error.preferences;
    payload.discoveryPreferenceRevision = error.discoveryPreferenceRevision;
    payload.hint = 'Preferences changed elsewhere. Refetch with trackly_get_preferences, reconcile with the user, and never retry blindly with the newer revision.';
  }

  if (error?.status === 429 && !payload.hint) {
    payload.hint = 'Daily limit reached (20 natural language queries per day).';
  }

  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    isError: true,
  };
}

function createAuthErrorResult() {
  return createErrorResult(
    { message: 'Not authenticated', status: 401 },
    'Not authenticated',
    { hint: AUTH_HINT }
  );
}

function throwMcpResourceError(error) {
  const normalizedMaintenance = maintenanceOutput(error);
  if (normalizedMaintenance) {
    throw new McpError(
      MCP_MAINTENANCE_ERROR_CODE,
      normalizedMaintenance.message,
      normalizedMaintenance,
    );
  }
  const normalizedAccess = createTracklyAccessError(error, error?.status);
  if (normalizedAccess) {
    throw new McpError(
      MCP_ACCESS_ERROR_CODE,
      normalizedAccess.message,
      {
        status: normalizedAccess.status,
        code: normalizedAccess.code,
        retryable: normalizedAccess.retryable,
      },
    );
  }
  if (error?.status === 401) {
    throw new McpError(
      MCP_AUTH_ERROR_CODE,
      error?.message || 'Not authenticated',
      { status: 401, hint: AUTH_HINT },
    );
  }
  throw error;
}

function wrapTool(handler, fallbackMessage) {
  return async (params) => {
    try {
      if (!hasAuth()) {
        return createAuthErrorResult();
      }

      const result = await handler(params);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return createErrorResult(
        error,
        fallbackMessage,
        error?.status === 401 ? { hint: AUTH_HINT } : {}
      );
    }
  };
}

function projectPreferenceResponse(result, experienceFilterV2Available = null) {
  const user = result?.user || {};
  return {
    success: result?.success === true,
    experienceFilterV2Available: experienceFilterV2Available === null
      ? user.experienceFilterV2Available === true
      : experienceFilterV2Available === true,
    preferences: user.preferences || result?.preferences || {},
  };
}

function createServer() {
  const server = new McpServer({
    name: 'trackly',
    version: PACKAGE_VERSION,
  });

  server.tool(
    'trackly_search_jobs',
    'Search and filter job postings. Returns matching jobs with title, company, location, and structured fields. Use companyId to filter jobs at a specific company (get companyId from trackly_search_companies first). Work arrangement is independent from region and employment type: use workArrangements for remote, hybrid, in-person, or unspecified classifications.',
    {
      function: z.enum(JOB_FUNCTIONS).optional().describe('Job function filter. One of: ' + JOB_FUNCTIONS.join(', ')),
      companyId: z.number().optional().describe('Filter jobs by company ID (get from trackly_search_companies)'),
      locationFilter: z.union([
        z.enum(['us', 'non_us', 'all']),
        z.enum(REGION_TAGS),
        z.array(z.enum(REGION_TAGS_ARRAY_SAFE)).min(1),
      ]).optional().describe(
        "Region tag filter. Pass ONE of: (a) a single scalar from 'us', 'non_us', 'all', or a REGION_TAGS value ('europe', 'latam', 'middle_east', 'asia', 'africa', 'canada', 'oceania', 'remote', 'unknown'); or (b) an array of region tags for multi-region (e.g. ['europe', 'canada']). The array form excludes 'us' — combining 'us' with other tags causes the backend to silently drop the others. For 'not US' use the scalar 'non_us' alone."
      ),
      jobModality: z.enum(JOB_MODALITIES).optional().describe(
        'Employment type (NOT work arrangement). full_time = full-time roles, internship = internships, all = both. Use workArrangements for remote, hybrid, or in-person classification.'
      ),
      workArrangements: z.array(z.enum(WORK_ARRANGEMENTS)).min(1).max(4).optional().describe(
        'Work arrangement filter, independent from geography and employment type. Values: remote, hybrid, in_person, unspecified. Multiple values use OR semantics.'
      ),
      remote: z.boolean().optional().describe('Filter to remote jobs only (maps to usStates=REMOTE).'),
      status: z.enum(STATUS_VALUES).optional().describe(
        'Filter by YOUR application pipeline state. Not a generic job-posting status. Values: ' + STATUS_VALUES.join(', ')
      ),
      sort: z.enum(SORT_VALUES).optional().describe('Sort order: newest (default) or match (highest match score first; requires resume). Backend rejects legacy oldest/company with HTTP 400.'),
      limit: z.number().max(50).optional().describe('Max results (default 20, max 50)'),
      offset: z.number().min(0).optional().describe('Pagination offset'),
      keywords: z.string().max(500).optional().describe('Keyword search in title, company, or description'),
    },
    wrapTool(async (params) => {
      const qs = new URLSearchParams();
      // When `function` isn't specified, request ALL canonical functions so the
      // backend takes the all-roles short-circuit (granola-followup-app
      // src/routes/jobscout.ts:3461, isAllJobFunctionsSelection). Otherwise the
      // backend's legacy fallback (jobscout.ts:3478) defaults to
      // `is_pm_role = TRUE`, returning 0 for companies with zero PM roles.
      // Surfaced 2026-05-20 on freshly-activated Cahoot (id=3349) and Iterative
      // Health (id=3350) — both had non-PM-only job sets and search_jobs
      // returned total=0 without an explicit function filter.
      qs.set('jobFunction', params.function !== undefined ? params.function : JOB_FUNCTIONS.join(','));
      if (params.companyId !== undefined) qs.set('companyId', String(params.companyId));
      if (params.locationFilter !== undefined) {
        const value = Array.isArray(params.locationFilter)
          ? params.locationFilter.join(',')
          : params.locationFilter;
        qs.set('locationFilter', value);
      }
      if (params.jobModality !== undefined) qs.set('jobModality', params.jobModality);
      if (params.workArrangements !== undefined) qs.set('workArrangements', params.workArrangements.join(','));
      if (params.remote === true) qs.set('usStates', 'REMOTE');
      if (params.status !== undefined) qs.set('status', params.status);
      if (params.sort !== undefined) qs.set('sort', params.sort);
      if (params.limit !== undefined) qs.set('limit', String(params.limit));
      if (params.offset !== undefined) qs.set('offset', String(params.offset));
      if (params.keywords !== undefined) qs.set('search', params.keywords);
      return apiRequest('GET', `/api/jobscout/jobs?${qs.toString()}`, null, false, false, MCP_USER_AGENT);
    }, 'Failed to search jobs')
  );

  server.tool(
    'trackly_get_job',
    'Get full details for a specific job posting including description.',
    {
      id: z.number().describe('Job posting ID'),
    },
    wrapTool(async ({ id }) => {
      return apiRequest('GET', `/api/jobscout/jobs/${id}`, null, false, false, MCP_USER_AGENT);
    }, 'Failed to fetch job')
  );

  server.tool(
    'trackly_search_companies',
    'Semantic search for companies by name, domain, or keywords.',
    {
      query: z.string().max(500).describe('Search query'),
      limit: z.number().max(50).optional().describe('Max results (default 10)'),
    },
    wrapTool(async ({ query, limit }) => {
      const qs = new URLSearchParams({ q: query });
      if (limit) qs.set('limit', String(limit));
      return apiRequest('GET', `/api/jobscout/companies/search?${qs.toString()}`, null, false, false, MCP_USER_AGENT);
    }, 'Failed to search companies')
  );

  server.tool(
    'trackly_list_companies',
    'List all tracked companies with their active job counts.',
    {
      limit: z.number().max(50).optional().describe('Max results'),
      offset: z.number().min(0).optional().describe('Pagination offset'),
    },
    wrapTool(async ({ limit, offset }) => {
      const qs = new URLSearchParams();
      if (limit) qs.set('limit', String(limit));
      if (offset !== undefined) qs.set('offset', String(offset));
      return apiRequest('GET', `/api/jobscout/companies?${qs.toString()}`, null, false, false, MCP_USER_AGENT);
    }, 'Failed to list companies')
  );

  server.tool(
    'trackly_get_stats',
    'Get job tracker metrics: total jobs, companies, application status counts.',
    {},
    wrapTool(async () => {
      return apiRequest('GET', '/api/jobscout/me', null, false, false, MCP_USER_AGENT);
    }, 'Failed to fetch stats')
  );

  server.tool(
    'trackly_get_preferences',
    'Read the authenticated user\'s discovery preferences, including selected and effective job functions, role-specific experience limits and active state, and the discoveryPreferenceRevision required for a safe update.',
    {},
    wrapTool(async () => {
      const result = await apiRequest('GET', '/api/jobscout/me', null, false, false, MCP_USER_AGENT);
      return projectPreferenceResponse(result);
    }, 'Failed to fetch preferences')
  );

  server.tool(
    'trackly_update_experience_limits',
    'Atomically replace the complete role-specific experience-limit map. Each value is the highest stated minimum years requirement the user wants for that job function. When Trackly enforcement is active, a job is included when its stated minimum is less than or equal to the limit. Jobs with no stated minimum remain visible. An empty object clears the saved limits. experienceFilterV2Available reports edit capability, not enforcement state. Read discoveryPreferenceRevision with trackly_get_preferences first. If the backend returns a revision conflict, refetch and reconcile with the user; never retry blindly with the newer revision.',
    {
      experienceLimitsByJobFunction: z.record(z.enum(JOB_FUNCTIONS), z.number().int().min(0).max(60)).describe(
        'Complete replacement map from canonical job-function slug to maximum acceptable stated minimum years. Use {} to turn role-specific experience filtering off.'
      ),
      expectedPreferenceRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).describe(
        'The non-negative safe-integer discoveryPreferenceRevision returned by the latest trackly_get_preferences call. A stale revision is rejected instead of overwriting newer choices.'
      ),
    },
    wrapTool(async ({ experienceLimitsByJobFunction, expectedPreferenceRevision }) => {
      const current = await apiRequest('GET', '/api/jobscout/me', null, false, false, MCP_USER_AGENT);
      if (current?.user?.experienceFilterV2Available !== true) {
        throw {
          status: 403,
          code: 'experience_filter_v2_unavailable',
          error: 'Role-specific experience preferences are not available for this account yet. No changes were saved.',
        };
      }
      const currentPreferences = current?.user?.preferences || {};
      const currentRevision = currentPreferences.discoveryPreferenceRevision;
      if (!Number.isSafeInteger(currentRevision) || currentRevision < 0) {
        throw {
          status: 502,
          code: 'invalid_preference_revision',
          error: 'Trackly did not return a valid preference revision. No changes were saved.',
        };
      }
      if (currentRevision !== expectedPreferenceRevision) {
        throw {
          status: 409,
          error: 'preference_revision_conflict',
          preferences: currentPreferences,
          discoveryPreferenceRevision: currentRevision,
        };
      }
      const result = await apiRequest('PUT', '/api/jobscout/preferences', {
        experienceLimitsByJobFunction,
        experienceFilterVersion: 2,
        expectedPreferenceRevision,
      }, false, false, MCP_USER_AGENT);
      return projectPreferenceResponse(result, true);
    }, 'Failed to update experience limits')
  );

  server.tool(
    'trackly_update_status',
    'Update a job application status (apply, save, or dismiss).',
    {
      id: z.number().describe('Job posting ID'),
      action: z.enum(['applied', 'saved', 'dismissed']).describe('Status action'),
    },
    wrapTool(async ({ id, action }) => {
      // Backend expects the stage name, not the human-friendly action name.
      // ACTION_TO_STAGE is defined at module scope (mirrors the same map in bin/trackly).
      const stage = ACTION_TO_STAGE[action];
      if (!stage) {
        // Defensive: the z.enum above already rejects values outside applied|saved|dismissed,
        // but if the enum is ever widened the mapping must be updated in lockstep — fail loud
        // rather than silently sending an unintended stage.
        throw new Error(`trackly_update_status: unknown action "${action}" — expected applied|saved|dismissed`);
      }
      return apiRequest('POST', `/api/jobscout/tracker/jobs/${id}/stage`, { stage }, false, false, MCP_USER_AGENT);
    }, 'Failed to update job status')
  );

  server.tool(
    'trackly_ask',
    'Natural language job search. Describe what you are looking for and the AI parses it into structured filters. Limited to 20 queries per day.',
    {
      query: z.string().max(500).describe('Natural language search query, e.g. "PM jobs at fintech companies in SF"'),
    },
    wrapTool(async ({ query }) => {
      const askResult = await apiRequest('GET', `/api/jobscout/ask?q=${encodeURIComponent(query)}`, null, false, false, MCP_USER_AGENT);
      if (askResult.jobsUrl) {
        // Path allowlist: /ask returns a jobsUrl string. normalizeEndpoint already blocks
        // cross-origin fetches, but a compromised backend could emit a same-origin path
        // like `/api/admin/secret-dump`. Only follow the two handlers /ask is designed to
        // route to. Mirrors the same guard in bin/trackly:cmdAsk.
        const JOBS_URL_ALLOWLIST = /^\/api\/(v1|jobscout)\/jobs(\?|$)/;
        if (JOBS_URL_ALLOWLIST.test(askResult.jobsUrl)) {
          const jobsResult = await apiRequest('GET', askResult.jobsUrl, null, false, false, MCP_USER_AGENT);
          return {
            ...askResult,
            jobs: jobsResult.jobs || jobsResult.data || [],
          };
        }
        // Untrusted jobsUrl. Strip it from the returned payload so the MCP client
        // doesn't receive (and potentially act on) a path we just refused to follow
        // ourselves. Include a telemetry breadcrumb so the agent sees the refusal.
        // (Copilot finding #2 on PR #21.)
        const { jobsUrl: _refused, ...safeAskResult } = askResult;
        return {
          ...safeAskResult,
          jobsUrl: null,
          jobsUrlRefused: true,
        };
      }
      return askResult;
    }, 'Failed to process natural language query')
  );

  server.tool(
    'trackly_get_job_brief',
    'Get a network brief for a specific job. Returns company signal, recommended motion, top contact, and suggested actions.',
    {
      jobId: z.number().describe('Job posting ID'),
    },
    wrapTool(async ({ jobId }) => {
      return apiRequest('GET', `/api/jobscout/jobs/${jobId}/network-brief`, null, false, false, MCP_USER_AGENT);
    }, 'Failed to fetch network brief')
  );

  server.tool(
    'trackly_contacts_at_company',
    'Search contacts at a specific company. Returns matching contacts with name, title, email, and status.',
    {
      company: z.string().max(200).describe('Company name to search contacts for'),
      limit: z.number().max(50).optional().describe('Max results (default 20)'),
    },
    wrapTool(async ({ company, limit }) => {
      const qs = new URLSearchParams({ search: company });
      if (limit) qs.set('limit', String(limit));
      return apiRequest('GET', `/api/network/people?${qs.toString()}`, null, false, false, MCP_USER_AGENT);
    }, 'Failed to search contacts at company')
  );

  server.tool(
    'trackly_get_company_workspace',
    'Get the full workspace view for a company: active jobs, contacts, hiring managers, coverage gap, and campaign status.',
    {
      companyId: z.number().describe('Company ID'),
    },
    wrapTool(async ({ companyId }) => {
      return apiRequest('GET', `/api/network/companies/${companyId}/workspace`, null, false, false, MCP_USER_AGENT);
    }, 'Failed to fetch company workspace')
  );

  server.tool(
    'trackly_request_company',
    'Request that a company be added to Trackly\'s tracked companies. Use when the user asks about a company that isn\'t in trackly_search_companies / trackly_list_companies results. Rate-limited to 5 pending requests per user.',
    {
      companyName: z.string().min(1).max(200).describe('Company name (e.g. "eBay")'),
      companyUrl: z.string().max(500).optional().describe('Optional careers page or homepage URL (e.g. "https://careers.ebay.com")'),
      notes: z.string().max(1000).optional().describe('Optional context (e.g. "MBA hiring page", "specific role I want tracked")'),
    },
    wrapTool(async ({ companyName, companyUrl, notes }) => {
      return apiRequest('POST', '/api/jobscout/companies/request', {
        company_name: companyName,
        company_url: companyUrl || '',
        notes: notes || '',
        source: 'mcp',
      }, false, false, MCP_USER_AGENT);
    }, 'Failed to request company')
  );

  // Trackly Apply tools. Keep schemas aligned with the hosted MCP server.
  server.tool(
    'trackly_get_apply_queue',
    'Get the deterministic queue of jobs the user already approved by saving as check later. Do not rescore or veto these jobs.',
    {
      limit: z.number().int().min(1).max(100).optional(),
      cursor: z.string().min(1).max(2048).optional(),
    },
    wrapTool(async ({ limit, cursor }) => {
      const qs = new URLSearchParams();
      if (limit !== undefined) qs.set('limit', String(limit));
      if (cursor) qs.set('cursor', cursor);
      const query = qs.toString();
      return apiRequest('GET', `/api/jobscout/apply/queue${query ? `?${query}` : ''}`, null, false, false, MCP_USER_AGENT);
    }, 'Failed to fetch apply queue')
  );

  server.tool(
    'trackly_get_application_profile',
    'Get the versioned application profile. Sensitive values are returned only after the user opted into encrypted storage.',
    {
      includeSensitive: z.boolean().optional(),
      provider: z.string().max(100).optional(),
      companyId: z.string().max(100).optional(),
    },
    wrapTool(async ({ includeSensitive, provider, companyId }) => {
      const qs = new URLSearchParams();
      if (includeSensitive) qs.set('includeSensitive', 'true');
      if (provider) qs.set('provider', provider);
      if (companyId) qs.set('companyId', companyId);
      return apiRequest('GET', `/api/jobscout/application-profile?${qs.toString()}`, null, false, false, MCP_USER_AGENT);
    }, 'Failed to fetch application profile')
  );

  server.tool(
    'trackly_get_profile_onboarding',
    'Get the backend-owned profile schema and onboarding questions. Ask only fields whose state is unknown or needs confirmation.',
    {},
    wrapTool(async () => {
      const [schema, profile] = await Promise.all([
        apiRequest('GET', '/api/jobscout/application-profile/schema', null, false, false, MCP_USER_AGENT),
        apiRequest('GET', '/api/jobscout/application-profile', null, false, false, MCP_USER_AGENT),
      ]);
      return { schema, profile };
    }, 'Failed to fetch profile onboarding')
  );

  server.tool(
    'trackly_update_application_profile',
    'Update confirmed profile answers with optimistic concurrency. Use global scope only for an explicit always-answer preference.',
    {
      expectedRevision: z.number().int().min(1),
      source: z.enum(['web', 'ios', 'macos', 'codex', 'claude', 'mcp']).optional(),
      changes: z.array(z.discriminatedUnion('scope', [
        z.object({
          key: z.string().min(1).max(200), state: z.enum(['unknown', 'answered', 'intentionally_blank', 'declined']),
          value: z.any().optional(), scope: z.literal('global'), questionLabel: z.string().max(1000).optional(),
        }),
        z.object({
          key: z.string().min(1).max(200), state: z.enum(['unknown', 'answered', 'intentionally_blank', 'declined']),
          value: z.any().optional(), scope: z.literal('provider'), scopeValue: z.string().min(1).max(200),
          questionLabel: z.string().max(1000).optional(),
        }),
        z.object({
          key: z.string().min(1).max(200), state: z.enum(['unknown', 'answered', 'intentionally_blank', 'declined']),
          value: z.any().optional(), scope: z.literal('company'), scopeValue: z.string().min(1).max(200),
          questionLabel: z.string().max(1000).optional(),
        }),
      ])).max(100).optional(),
      education: z.array(z.object({
        school: z.string().min(1).max(500),
        degree: z.string().max(500).nullable().optional(),
        fieldOfStudy: z.string().max(500).nullable().optional(),
        gpa: z.string().max(50).nullable().optional(),
        startDate: z.string().max(50).nullable().optional(),
        endDate: z.string().max(50).nullable().optional(),
      })).max(20).optional(),
      confirmProfile: z.boolean().optional(),
      sensitiveStorageConsent: z.boolean().optional(),
    },
    wrapTool(async (params) => apiRequest('PATCH', '/api/jobscout/application-profile', params, false, false, MCP_USER_AGENT), 'Failed to update application profile')
  );

  server.tool(
    'trackly_create_apply_batch',
    'Freeze an exact recent-first set of approved Check Later jobs before browser work. New queue entries never change this batch.',
    {
      limit: z.number().int().min(1).max(100),
      idempotencyKey: z.string().min(16).max(200).regex(SAFE_IDEMPOTENCY_KEY),
    },
    wrapTool(async ({ limit, idempotencyKey }) => apiRequest(
      'POST',
      '/api/jobscout/apply/batches',
      { limit },
      false,
      false,
      MCP_USER_AGENT,
      { 'Idempotency-Key': idempotencyKey }
    ), 'Failed to create apply batch')
  );

  server.tool(
    'trackly_get_apply_batch',
    'Read an existing frozen Apply batch by opaque server pagination. Do not reorder, replace, or rescore members.',
    {
      batchId: z.number().int().min(1),
      limit: z.number().int().min(1).max(100).optional(),
      cursor: z.string().min(1).max(2048).optional(),
    },
    wrapTool(async ({ batchId, limit, cursor }) => {
      const qs = new URLSearchParams();
      if (limit !== undefined) qs.set('limit', String(limit));
      if (cursor) qs.set('cursor', cursor);
      const query = qs.toString();
      return apiRequest(
        'GET',
        `/api/jobscout/apply/batches/${batchId}${query ? `?${query}` : ''}`,
        null,
        false,
        false,
        MCP_USER_AGENT
      );
    }, 'Failed to fetch apply batch')
  );

  server.tool(
    'trackly_claim_apply_batch',
    'Acquire or renew the optimistic lease required before mutating browser-bound batch members.',
    {
      batchId: z.number().int().min(1),
      expectedRevision: z.number().int().min(1),
      leaseOwner: z.string().min(1).max(1024),
      leaseToken: z.string().min(1).max(1024),
      leaseDurationMs: z.number().int().min(15000).max(300000),
    },
    wrapTool(async ({ batchId, ...body }) => apiRequest(
      'POST',
      `/api/jobscout/apply/batches/${batchId}/claim`,
      body,
      false,
      false,
      MCP_USER_AGENT
    ), 'Failed to claim apply batch')
  );

  server.tool(
    'trackly_checkpoint_apply_batch',
    'Bulk-checkpoint up to 20 browser inspections. Persist only typed actions and redacted fingerprints; never send labels, options, answers, credentials, OTPs, CAPTCHA text, or page content.',
    {
      batchId: z.number().int().min(1),
      leaseToken: z.string().min(1).max(1024),
      checkpoints: z.array(z.object({
        memberId: z.number().int().min(1),
        runId: z.number().int().min(1),
        expectedMemberVersion: z.number().int().min(1),
        expectedInspectionEpoch: z.number().int().min(0),
        inspectionEpoch: z.number().int().min(1),
        actionCode: z.enum(APPLY_CHECKPOINT_ACTION_CODES),
        continuationAllowed: z.boolean(),
        fieldFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
        packetPhase: z.enum(APPLY_CHECKPOINT_PACKET_PHASES).optional(),
        knownFieldsCommitted: z.boolean(),
        idempotencyKey: z.string().min(16).max(200).regex(SAFE_IDEMPOTENCY_KEY),
      })).min(1).max(20),
    },
    wrapTool(async ({ batchId, ...body }) => apiRequest(
      'POST',
      `/api/jobscout/apply/batches/${batchId}/checkpoints`,
      body,
      false,
      false,
      MCP_USER_AGENT
    ), 'Failed to checkpoint apply batch')
  );

  server.tool(
    'trackly_start_apply_run',
    'Start a manual-submit browser run for a job already in the approved queue. If maintenance interrupts an existing run, do not call this tool again: wait, refetch protocol/profile state, and resume that same run.',
    {
      jobId: z.number().int().min(1),
      clientName: z.string().max(100).optional(),
      batchId: z.number().int().min(1).optional(),
      memberId: z.number().int().min(1).optional(),
      expectedMemberVersion: z.number().int().min(1).optional(),
      expectedInspectionEpoch: z.number().int().min(0).optional(),
      leaseToken: z.string().min(1).max(1024).optional(),
    },
    wrapTool(async (params) => apiRequest('POST', '/api/jobscout/apply/runs', params, false, false, MCP_USER_AGENT), 'Failed to start apply run')
  );

  server.tool(
    'trackly_get_apply_evidence',
    'Get the authenticated user\'s aggregate, value-free Apply beta evidence and release gate. The report never returns answers, contact values, addresses, or page text.',
    {
      windowDays: z.number().int().min(1).max(365).optional(),
      targetReviewedRuns: z.number().int().min(1).max(1000).optional(),
    },
    wrapTool(async ({ windowDays, targetReviewedRuns }) => {
      const qs = new URLSearchParams();
      if (windowDays !== undefined) qs.set('windowDays', String(windowDays));
      if (targetReviewedRuns !== undefined) qs.set('targetReviewedRuns', String(targetReviewedRuns));
      const query = qs.toString();
      const suffix = query ? `?${query}` : '';
      return apiRequest('GET', `/api/jobscout/apply/evidence${suffix}`, null, false, false, MCP_USER_AGENT);
    }, 'Failed to fetch apply evidence')
  );

  server.tool(
    'trackly_get_apply_protocol',
    'Get the current browser workflow, ATS support matrix, integrity rules, and compatible public-skill major version. Fetch at the start of every run and again after maintenance before resuming the existing run.',
    {},
    wrapTool(async () => apiRequest('GET', '/api/jobscout/apply/protocol', null, false, false, MCP_USER_AGENT), 'Failed to fetch apply protocol')
  );

  server.tool(
    'trackly_report_apply_observation',
    'Report a redacted ATS mechanics or scenario-coverage observation. Never include answer values, addresses, contact data, OTPs, or free-form page content.',
    {
      runId: z.number().int().min(1),
      provider: z.string().regex(SAFE_OBSERVATION_CODE),
      fieldLabel: z.string().min(1).max(1000),
      observationType: z.string().regex(SAFE_OBSERVATION_CODE),
      resolutionCode: z.string().regex(SAFE_OBSERVATION_CODE).optional(),
      metadata: z.object({
        controlType: z.string().regex(SAFE_OBSERVATION_CODE).optional(),
        required: z.boolean().optional(),
        errorCode: z.string().regex(SAFE_OBSERVATION_CODE).optional(),
        committed: z.boolean(),
        scenarioCode: z.enum(APPLY_SCENARIO_CODES),
        browserSurface: z.enum(APPLY_BROWSER_SURFACES),
        browserBindingHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
        resumedAfterHandoff: z.boolean().optional(),
      }),
    },
    wrapTool(async (params) => apiRequest('POST', '/api/jobscout/apply/observations', params, false, false, MCP_USER_AGENT), 'Failed to report apply observation')
  );

  server.tool(
    'trackly_record_application_outcome',
    'Record review readiness or a user-confirmed outcome. Mark submitted only after a success page or explicit user confirmation.',
    {
      runId: z.number().int().min(1),
      outcome: z.enum(['review_ready', 'submitted', 'failed', 'blocked']),
      confirmation: z.string().max(500).optional(),
    },
    wrapTool(async ({ runId, ...body }) => apiRequest('POST', `/api/jobscout/apply/runs/${runId}/outcome`, body, false, false, MCP_USER_AGENT), 'Failed to record application outcome')
  );

  server.tool(
    'trackly_prepare_resume',
    'Download the authenticated default resume into a mode-0600 temporary Trackly cache and return exact-file proof for user confirmation before browser upload.',
    {
      runId: z.number().int().min(1),
      browserSurface: z.enum(APPLY_BROWSER_SURFACES),
      browserBindingHash: z.string().regex(/^[a-f0-9]{64}$/),
    },
    wrapTool(async ({ runId, browserSurface, browserBindingHash }) =>
      prepareResume(runId, browserSurface, browserBindingHash), 'Failed to prepare default resume')
  );

  server.tool(
    'trackly_verify_prepared_resume',
    'Immediately before attachment, recompute the prepared resume fingerprint, validate its run and expiration, and lock the confirmed file read-only.',
    {
      runId: z.number().int().min(1),
      confirmationId: z.string().min(1).max(200),
      exactLocalPath: z.string().min(1).max(4096),
      sha256: z.string().regex(/^[a-f0-9]{64}$/i),
      sizeBytes: z.number().int().min(1),
      expiresAt: z.string().datetime(),
    },
    wrapTool(async (proof) => verifyPreparedResume(proof), 'Prepared resume integrity verification failed')
  );

  server.registerPrompt('trackly-apply', {
    title: 'Apply to the next Trackly job',
    description: 'Run the manual-submit Trackly Apply workflow for the next user-approved job.',
  }, async () => ({
    messages: [{
      role: 'user',
      content: {
        type: 'text',
        text: 'Compatibility gate: before starting a new run, require the fetched Trackly Apply protocol to be version 3.1.0 or newer. After trackly_start_apply_run returns, or before resuming an existing run, require the returned or stored run.protocolVersion to be version 3.1.0 or newer. Never continue or replace a pre-evidence 3.0.x run; preserve it, record it blocked when possible, and stop for supported lifecycle cleanup.',
      },
    }, {
      role: 'user',
      content: {
        type: 'text',
        text: 'Fetch the Trackly Apply protocol, profile onboarding, profile, and approved queue. Resolve missing answers with me. Treat required completeness separately from optional reusable coverage and employer-specific contextual questions. Before starting anything, stop on every non-null executionBlocker and every manual_only item. Start only the selected approved queue item, require major(run.protocolVersion) === major(protocol.version), require protocol.compatibleSkillMajor === 4, preserve the stored version for a resumed run, and require its provider, atsCapability, required scenarios, and originPolicy to match the queue preflight. Reclaim semantic browser control, verify the exact job/run/tab binding, hash that value-free binding, and report the same-run browser_ready attestation with committed=true. Before entering private data, require the visible company and role to match the run binding and, when available, the requisition identifier to match the stored job URL. When job_identity_match is required, report a value-free committed scenario_coverage attestation only after that visible identity check passes; never include the company, role, URL, requisition identifier, page text, or any profile value in that observation. On exact-origin fallback, revalidate the frozen company, role, and available requisition identity after every navigation or redirect and before entering any additional private data. Normalize every page, redirect, and data-receiving iframe URL; accept an exact authorized origin or hostname only when host === allowedDomain or host.endsWith("." + allowedDomain), never by substring or page text. When originPolicy.verification is trackly_employer_source_exact_origin, authorize only the exact origin in authorizedOrigins: never promote it to a host suffix and never carry it across a redirect or iframe origin change. For every other vendor-hosted ATS policy, require both originPolicy.tenantRule and originPolicy.verifiedAtsTenant to be non-null or stop before private data entry. Execute the backend-owned originPolicy.tenantRule exactly after every redirect or data-receiving iframe change, including its extraction, exact-host-depth, locale, percent-decoding, normalization, and fail-closed semantics, then require the normalized result to equal originPolicy.verifiedAtsTenant; never invent or reinterpret a strategy token. Obey every capability stop condition. Determine whether the form has a semantically identified Resume or CV attachment control. Only when that specific control exists, prepare the run-bound resume locally with that browser surface and binding hash, show me its exact path, filename, size, SHA-256, run, and expiration, and obtain my explicit confirmation. Treat cover-letter, portfolio, transcript, and other supporting-document controls separately according to the profile and protocol; never upload a resume to them. Immediately before attaching the resume, use the local verifier to validate the signed proof, recompute hash and size, check expiration, and lock the file read-only. Fill the form through semantic controls, verify committed values and every required error, and report a same-run passed or corrected scenario_coverage observation with committed=true for every backend-required scenario except browser_reclaim, which is satisfied only by browser_ready with the binding hash. Before every review_ready outcome, also report value-free committed critical_contact_integrity and manual_submit_boundary evidence; never include contact values, answers, page text, or local paths. If a required or universal review scenario cannot pass, record blocked rather than review_ready. Stop before Submit. If maintenance interrupts the run, retain the run and browser context, wait for the advertised window, refetch protocol, queue, and profile state, and resume the existing agent_browser run. Never start a duplicate run, blindly retry a mutation, enter credentials or verification codes, evade human verification, or click Submit.',
      },
    }],
  }));

  server.registerResource('trackly-apply-protocol', 'trackly://apply/protocol', {
    title: 'Current Trackly Apply protocol',
    description: 'Versioned browser mechanics and compatibility contract.',
    mimeType: 'application/json',
  }, async (uri) => {
    try {
      const result = await apiRequest('GET', '/api/jobscout/apply/protocol', null, false, false, MCP_USER_AGENT);
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(result) }] };
    } catch (error) {
      return throwMcpResourceError(error);
    }
  });

  return server;
}

async function startMcpServer() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return server;
}

if (require.main === module) {
  startMcpServer().catch((error) => {
    console.error('MCP server error:', error);
    process.exit(1);
  });
}

module.exports = {
  AUTH_HINT,
  createAuthErrorResult,
  createErrorResult,
  createServer,
  startMcpServer,
  throwMcpResourceError,
};
