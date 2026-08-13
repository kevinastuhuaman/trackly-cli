'use strict';

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { McpError } = require('@modelcontextprotocol/sdk/types.js');
const { z } = require('zod');
const { apiRequest, createTracklyAccessError, hasAuth, maintenanceOutput } = require('../lib/client');
const { version: PACKAGE_VERSION } = require('../package.json');
const { registerApplyTools } = require('./apply-tools');
const { configureMcpAnalytics, shutdownMcpAnalytics } = require('./analytics');

const MCP_USER_AGENT = `trackly-mcp/${PACKAGE_VERSION}`;
const MCP_MAINTENANCE_ERROR_CODE = -32002;
const MCP_ACCESS_ERROR_CODE = -32003;
const MCP_AUTH_ERROR_CODE = -32004;
const AUTH_HINT =
  'Existing members: run `trackly login` or set TRACKLY_API_KEY. ' +
  'New members need a private invite during the limited rollout; request access at https://usetrackly.app/early-access.';
const MCP_ANALYTICS_CONTEXT_DESCRIPTION =
  'Briefly explain why this tool helps the current job-search goal. Never include resume text, profile answers, demographic or work-authorization answers, application notes, credentials, or secrets.';

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

const MCP_MISSING_CAPABILITY_VALUES = [
  'search', 'inspect', 'compare', 'rank', 'recommend', 'track', 'update', 'apply',
  'submit', 'export', 'notify', 'schedule', 'integrate', 'authenticate', 'debug', 'other',
];
const MCP_MISSING_ACTION_VALUES = [
  'find', 'read', 'compare', 'rank', 'create', 'update', 'delete', 'submit',
  'export', 'notify', 'schedule', 'connect', 'debug', 'other',
];
const MCP_MISSING_RESOURCE_VALUES = [
  'job', 'company', 'application', 'contact', 'profile', 'resume', 'preference',
  'analytics', 'account', 'tool', 'other',
];
const MCP_MISSING_DESTINATION_VALUES = [
  'trackly', 'external_site', 'file', 'email', 'calendar', 'crm', 'browser', 'other',
];

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
    || error?.code === 'sensitive_revocation_confirmation_required'
    || error?.code === 'invalid_profile_revision'
    || error?.code === 'invalid_profile_response'
  ) {
    payload.code = error.code;
  }

  if (error?.code === 'sensitive_revocation_confirmation_required' && error?.confirmation) {
    payload.confirmation = error.confirmation;
  }

  if (error?.status === 409 && error?.error === 'sensitive_revocation_confirmation_required' && error?.confirmation) {
    payload.code = error.error;
    payload.confirmation = error.confirmation;
  }

  if (error?.status === 409 && error?.error === 'preference_revision_conflict') {
    payload.preferences = error.preferences;
    payload.discoveryPreferenceRevision = error.discoveryPreferenceRevision;
    payload.hint = 'Preferences changed elsewhere. Refetch with trackly_get_preferences, reconcile with the user, and never retry blindly with the newer revision.';
  }

  if (
    error?.status === 503
    && error?.error === 'application_profile_schema_pending'
    && error?.retryable === true
  ) {
    payload.code = error.error;
    payload.retryable = true;
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
  return async (params, extra) => {
    try {
      if (!hasAuth()) {
        return createAuthErrorResult();
      }

      const result = await handler(params);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      if (extra && typeof extra === 'object') {
        extra.__mcp_analytics_error = error instanceof Error
          ? error
          : new Error(error?.message || fallbackMessage, { cause: error });
      }
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

  registerApplyTools(server, {
    wrapTool,
    mcpUserAgent: MCP_USER_AGENT,
    throwMcpResourceError,
  });

  server.tool(
    'get_more_tools',
    'Report a capability Trackly does not currently provide. Use structured categories; context is optional and is classified but never stored as raw text.',
    {
      requestedCapability: z.enum(MCP_MISSING_CAPABILITY_VALUES).optional(),
      requestedAction: z.enum(MCP_MISSING_ACTION_VALUES).optional(),
      requestedResource: z.enum(MCP_MISSING_RESOURCE_VALUES).optional(),
      requestedDestination: z.enum(MCP_MISSING_DESTINATION_VALUES).optional(),
      context: z.string().optional().describe(MCP_ANALYTICS_CONTEXT_DESCRIPTION),
    },
    async () => ({
      content: [{
        type: 'text',
        text: JSON.stringify({ accepted: true, delivery: 'best_effort' }),
      }],
    }),
  );

  return server;
}

// Keep `createServer` a deterministic catalog factory for embedders and
// contract verification. Analytics belongs at the executable startup boundary,
// after every source tool has been registered.
function configureServerAnalytics(server, options = {}) {
  if (typeof options.configureAnalytics === 'function') {
    return options.configureAnalytics(server, options.analytics);
  }
  return configureMcpAnalytics(server, options.analytics);
}

async function startMcpServer(options = {}) {
  const server = createServer();
  configureServerAnalytics(server, options);
  const transport = options.transport || new StdioServerTransport();
  const shutdownAnalytics = options.shutdownAnalytics || shutdownMcpAnalytics;
  const previousOnClose = server.server.onclose;
  const beginAnalyticsShutdown = () => {
    try {
      Promise.resolve(shutdownAnalytics(server)).catch(() => {});
    } catch {
      // Analytics teardown must not affect transport teardown.
    }
  };
  server.server.onclose = () => {
    try {
      previousOnClose?.();
    } catch {
      // Preserve fail-open behavior if an instrumentation callback misbehaves.
    }
    beginAnalyticsShutdown();
  };

  try {
    await server.connect(transport);
  } catch (error) {
    try {
      await shutdownAnalytics(server);
    } catch {
      // Preserve the original transport failure.
    }
    throw error;
  }
  return server;
}

function installMcpSignalHandlers(server, options = {}) {
  const signalTarget = options.signalTarget || process;
  const exit = options.exit || ((code) => process.exit(code));
  const shutdownAnalytics = options.shutdownAnalytics || shutdownMcpAnalytics;
  let terminating = false;
  const handlers = new Map();
  const cleanup = () => {
    for (const [signal, handler] of handlers) {
      signalTarget.removeListener(signal, handler);
    }
    handlers.clear();
  };
  for (const [signal, exitCode] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    const handler = () => {
      if (terminating) return;
      terminating = true;
      void Promise.resolve()
        .then(() => shutdownAnalytics(server))
        .catch(() => {})
        .finally(() => {
          cleanup();
          exit(exitCode);
        });
    };
    handlers.set(signal, handler);
    signalTarget.on(signal, handler);
  }
  return cleanup;
}

if (require.main === module) {
  startMcpServer()
    .then((server) => installMcpSignalHandlers(server))
    .catch((error) => {
      console.error('MCP server error:', error);
      process.exit(1);
    });
}

module.exports = {
  AUTH_HINT,
  createAuthErrorResult,
  createErrorResult,
  configureServerAnalytics,
  createServer,
  installMcpSignalHandlers,
  startMcpServer,
  throwMcpResourceError,
};
