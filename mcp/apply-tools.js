'use strict';

const { z } = require('zod');
const { apiRequest } = require('../lib/client');
const { prepareResume, verifyPreparedResume } = require('../lib/agent');
const APPLY_CONTRACT = require('../contracts/trackly-apply-tools.json');

const APPLY_BROWSER_SURFACES = APPLY_CONTRACT.constants.applyBrowserSurfaces;
const APPLY_SCENARIO_CODES = APPLY_CONTRACT.constants.applyScenarioCodes;
const APPLY_CHECKPOINT_ACTION_CODES = APPLY_CONTRACT.constants.applyCheckpointActionCodes;
const APPLY_CHECKPOINT_PACKET_PHASES = APPLY_CONTRACT.constants.applyCheckpointPacketPhases;
const APPLY_SURFACE_BINDING_REASONS = APPLY_CONTRACT.constants.applySurfaceBindingReasons;
const APPLY_SURFACE_EVIDENCE_TYPES = APPLY_CONTRACT.constants.applySurfaceEvidenceTypes;
const APPLY_SURFACE_OWNERSHIP_STATES = APPLY_CONTRACT.constants.applySurfaceOwnershipStates;
const APPLY_SUBMISSION_EVIDENCE_TYPES = APPLY_CONTRACT.constants.applySubmissionEvidenceTypes;
const APPLY_SUBMISSION_EVIDENCE_SOURCES = APPLY_CONTRACT.constants.applySubmissionEvidenceSources;
const APPLY_BATCH_MAX_MEMBERS = 100;
const APPLY_BATCH_MAX_CHECKPOINTS_PER_REQUEST = 20;
const APPLY_BATCH_MAX_ACTIONS_PER_CHECKPOINT = 25;
const APPLY_BATCH_MAX_BULK_MUTATIONS = 20;
const SAFE_OBSERVATION_CODE = /^[a-z0-9][a-z0-9_:-]{0,99}$/;
const SAFE_IDEMPOTENCY_KEY = /^[\x20-\x7e]+$/;

const truthCertificationCommon = {
  batchId: z.number().int().min(1),
  leaseToken: z.string().min(1).max(1024),
  membershipHash: z.string().regex(/^[a-f0-9]{64}$/),
  profileRevision: z.number().int().min(0),
  memberRuns: z.array(z.object({
    memberId: z.number().int().min(1),
    runId: z.number().int().min(1),
    memberVersion: z.number().int().min(1),
    inspectionEpoch: z.number().int().min(0),
  })).min(1).max(100),
  answerSnapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
  wordingFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  expiresAt: z.string().datetime(),
  idempotencyKey: z.string().min(16).max(200).regex(SAFE_IDEMPOTENCY_KEY),
};

// The MCP SDK can publish only top-level object schemas through tools/list.
// Keep discovery concrete, then apply the exact cross-field invariant in the handler.
const truthCertificationInputSchema = z.object({
  ...truthCertificationCommon,
  resumeDependency: z.enum(['approved', 'not_applicable']),
  resumeId: z.number().int().min(1).nullable().optional(),
  resumeSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable().optional(),
});
const truthCertificationSchema = z.discriminatedUnion('resumeDependency', [
  z.object({
    ...truthCertificationCommon,
    resumeDependency: z.literal('approved'),
    resumeId: z.number().int().min(1),
    resumeSha256: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  z.object({
    ...truthCertificationCommon,
    resumeDependency: z.literal('not_applicable'),
    resumeId: z.null().optional(),
    resumeSha256: z.null().optional(),
  }),
]);

const startApplyRunInputSchema = z.object({
  jobId: z.number().int().min(1),
  clientName: z.string().max(100).optional(),
  batchId: z.number().int().min(1).optional(),
  memberId: z.number().int().min(1).optional(),
  expectedMemberVersion: z.number().int().min(1).optional(),
  expectedInspectionEpoch: z.number().int().min(0).optional(),
  leaseToken: z.string().min(1).max(1024).optional(),
});
const startApplyRunSchema = z.object({
  jobId: z.number().int().min(1),
  clientName: z.string().max(100).optional(),
  batchId: z.number().int().min(1).optional(),
  memberId: z.number().int().min(1).optional(),
  expectedMemberVersion: z.number().int().min(1).optional(),
  expectedInspectionEpoch: z.number().int().min(0).optional(),
  leaseToken: z.string().min(1).max(1024).optional(),
}).superRefine((value, context) => {
  const batchValues = [
    value.batchId,
    value.memberId,
    value.expectedMemberVersion,
    value.expectedInspectionEpoch,
    value.leaseToken,
  ];
  if (
    batchValues.some((item) => item !== undefined)
    && batchValues.some((item) => item === undefined)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Batch binding fields must be supplied together',
    });
  }
});

function registerApplyTools(
  server,
  {
    wrapTool,
    mcpUserAgent: MCP_USER_AGENT,
    throwMcpResourceError,
  },
) {
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
      limit: z.number().int().min(1).max(APPLY_BATCH_MAX_MEMBERS).optional(),
      cursor: z.string().min(1).max(2048).optional(),
      actionLimit: z.number().int().min(1).max(APPLY_BATCH_MAX_MEMBERS).optional(),
      actionCursor: z.string().min(1).max(2048).optional(),
    },
    wrapTool(async ({ batchId, limit, cursor, actionLimit, actionCursor }) => {
      const qs = new URLSearchParams();
      if (limit !== undefined) qs.set('limit', String(limit));
      if (cursor) qs.set('cursor', cursor);
      if (actionLimit !== undefined) qs.set('actionLimit', String(actionLimit));
      if (actionCursor) qs.set('actionCursor', actionCursor);
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
    'trackly_get_active_apply_batch',
    'Recover the newest unexpired frozen Apply batch for this user after context loss. Returns active=false when no resumable batch exists.',
    {
      limit: z.number().int().min(1).max(APPLY_BATCH_MAX_MEMBERS).optional(),
      cursor: z.string().min(1).max(2048).optional(),
      actionLimit: z.number().int().min(1).max(APPLY_BATCH_MAX_MEMBERS).optional(),
      actionCursor: z.string().min(1).max(2048).optional(),
    },
    wrapTool(async ({ limit, cursor, actionLimit, actionCursor }) => {
      const qs = new URLSearchParams();
      if (limit !== undefined) qs.set('limit', String(limit));
      if (cursor) qs.set('cursor', cursor);
      if (actionLimit !== undefined) qs.set('actionLimit', String(actionLimit));
      if (actionCursor) qs.set('actionCursor', actionCursor);
      const query = qs.toString();
      return apiRequest(
        'GET',
        `/api/jobscout/apply/batches/active${query ? `?${query}` : ''}`,
        null,
        false,
        false,
        MCP_USER_AGENT
      );
    }, 'Failed to recover active apply batch')
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
        inspectionEpoch: z.number().int().min(0),
        packetPhase: z.enum(APPLY_CHECKPOINT_PACKET_PHASES).optional(),
        knownFieldsCommitted: z.boolean(),
        resolvedActionIds: z.array(z.string().regex(/^[1-9][0-9]*$/))
          .max(APPLY_BATCH_MAX_ACTIONS_PER_CHECKPOINT).optional(),
        idempotencyKey: z.string().min(16).max(200).regex(SAFE_IDEMPOTENCY_KEY),
        actions: z.array(z.object({
          actionCode: z.enum(APPLY_CHECKPOINT_ACTION_CODES),
          continuationAllowed: z.boolean(),
          fieldFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
        })).min(1).max(APPLY_BATCH_MAX_ACTIONS_PER_CHECKPOINT),
      })).min(1).max(APPLY_BATCH_MAX_CHECKPOINTS_PER_REQUEST),
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
    'trackly_approve_apply_batch_resume',
    'Record one explicit approval for the exact default-resume identity and immutable current run set. Every local attachment still requires immediate path/hash verification.',
    {
      batchId: z.number().int().min(1),
      leaseToken: z.string().min(1).max(1024),
      membershipHash: z.string().regex(/^[a-f0-9]{64}$/),
      profileRevision: z.number().int().min(0),
      resumeId: z.number().int().min(1),
      resumeSha256: z.string().regex(/^[a-f0-9]{64}$/),
      resumeFilename: z.string().min(1).max(255),
      resumeSizeBytes: z.number().int().min(1),
      memberRuns: z.array(z.object({
        memberId: z.number().int().min(1),
        runId: z.number().int().min(1),
        memberVersion: z.number().int().min(1),
        inspectionEpoch: z.number().int().min(0),
      })).min(1).max(100),
      expiresAt: z.string().datetime(),
      idempotencyKey: z.string().min(16).max(200).regex(SAFE_IDEMPOTENCY_KEY),
    },
    wrapTool(async ({ batchId, idempotencyKey, ...body }) => apiRequest(
      'POST',
      `/api/jobscout/apply/batches/${batchId}/resume-approval`,
      body,
      false,
      false,
      MCP_USER_AGENT,
      { 'Idempotency-Key': idempotencyKey }
    ), 'Failed to approve batch resume')
  );

  server.tool(
    'trackly_bind_apply_surface',
    'Bind an initial or recovered browser surface to an existing frozen member and run. This increments the inspection epoch and returns only the exact backend-stored requisition URL; it never creates a replacement run.',
    {
      batchId: z.number().int().min(1),
      memberId: z.number().int().min(1),
      runId: z.number().int().min(1),
      expectedMemberVersion: z.number().int().min(1),
      expectedInspectionEpoch: z.number().int().min(0),
      leaseToken: z.string().min(1).max(1024),
      browserBindingHash: z.string().regex(/^[a-f0-9]{64}$/),
      browserSurface: z.enum(APPLY_BROWSER_SURFACES),
      adapterCode: z.string().regex(SAFE_OBSERVATION_CODE),
      bindingReason: z.enum(APPLY_SURFACE_BINDING_REASONS),
      idempotencyKey: z.string().min(16).max(200).regex(SAFE_IDEMPOTENCY_KEY),
    },
    wrapTool(async ({ batchId, memberId, idempotencyKey, ...body }) => apiRequest(
      'POST',
      `/api/jobscout/apply/batches/${batchId}/members/${memberId}/surface-binding`,
      body,
      false,
      false,
      MCP_USER_AGENT,
      { 'Idempotency-Key': idempotencyKey }
    ), 'Failed to bind apply browser surface')
  );

  server.tool(
    'trackly_record_apply_surface_evidence',
    'Record value-free current-epoch inventory, missing-tab, close-receipt, post-close absence, or close-failure evidence. closed_verified requires complete controller+user union inventory, an explicit close receipt, and post-close union absence.',
    {
      batchId: z.number().int().min(1),
      memberId: z.number().int().min(1),
      runId: z.number().int().min(1),
      expectedMemberVersion: z.number().int().min(1),
      expectedInspectionEpoch: z.number().int().min(1),
      leaseToken: z.string().min(1).max(1024),
      browserBindingHash: z.string().regex(/^[a-f0-9]{64}$/),
      browserSurface: z.enum(APPLY_BROWSER_SURFACES),
      adapterCode: z.string().regex(SAFE_OBSERVATION_CODE),
      ownershipState: z.enum(APPLY_SURFACE_OWNERSHIP_STATES),
      completeInventory: z.boolean(),
      evidenceType: z.enum(APPLY_SURFACE_EVIDENCE_TYPES),
      idempotencyKey: z.string().min(16).max(200).regex(SAFE_IDEMPOTENCY_KEY),
    },
    wrapTool(async ({ batchId, memberId, idempotencyKey, ...body }) => apiRequest(
      'POST',
      `/api/jobscout/apply/batches/${batchId}/members/${memberId}/surface-evidence`,
      body,
      false,
      false,
      MCP_USER_AGENT,
      { 'Idempotency-Key': idempotencyKey }
    ), 'Failed to record apply browser surface evidence')
  );

  server.tool(
    'trackly_record_apply_submission_evidence',
    'Record redacted request, success-page, explicit user-confirmation, or provider-receipt evidence for the current batch member and inspection epoch. Never send page text, receipt identifiers, or external references.',
    {
      batchId: z.number().int().min(1),
      memberId: z.number().int().min(1),
      runId: z.number().int().min(1),
      expectedMemberVersion: z.number().int().min(1),
      expectedInspectionEpoch: z.number().int().min(1),
      leaseToken: z.string().min(1).max(1024),
      browserBindingHash: z.string().regex(/^[a-f0-9]{64}$/),
      evidenceType: z.enum(APPLY_SUBMISSION_EVIDENCE_TYPES),
      evidenceSource: z.enum(APPLY_SUBMISSION_EVIDENCE_SOURCES),
      evidenceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
      idempotencyKey: z.string().min(16).max(200).regex(SAFE_IDEMPOTENCY_KEY),
    },
    wrapTool(async ({ batchId, memberId, idempotencyKey, ...body }) => apiRequest(
      'POST',
      `/api/jobscout/apply/batches/${batchId}/members/${memberId}/submission-evidence`,
      body,
      false,
      false,
      MCP_USER_AGENT,
      { 'Idempotency-Key': idempotencyKey }
    ), 'Failed to record apply submission evidence')
  );

  server.registerTool(
    'trackly_certify_apply_batch_truth',
    {
      description: 'Record a late, expiring truthfulness certification over final answer and wording fingerprints for the exact complete subset that is currently review-ready. Unresolved members remain resumable and do not block ready siblings. This never becomes a profile answer.',
      inputSchema: truthCertificationInputSchema,
    },
    wrapTool(async (params) => {
      const {
        batchId,
        idempotencyKey,
        ...body
      } = truthCertificationSchema.parse(params);
      return apiRequest(
        'POST',
        `/api/jobscout/apply/batches/${batchId}/truth-certification`,
        body,
        false,
        false,
        MCP_USER_AGENT,
        { 'Idempotency-Key': idempotencyKey }
      );
    }, 'Failed to certify batch truthfulness')
  );

  server.registerTool(
    'trackly_start_apply_run',
    {
      description: 'Start a legacy single run, or start/recover a frozen member when the complete batch binding is supplied. Recovered members already carrying runId must reuse that run without calling this tool.',
      inputSchema: startApplyRunInputSchema,
    },
    wrapTool(async (params) => apiRequest(
      'POST',
      '/api/jobscout/apply/runs',
      startApplyRunSchema.parse(params),
      false,
      false,
      MCP_USER_AGENT
    ), 'Failed to start apply run')
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
      batchId: z.number().int().min(1).optional(),
      memberId: z.number().int().min(1).optional(),
      inspectionEpoch: z.number().int().min(0).optional(),
      leaseToken: z.string().min(1).max(1024).optional(),
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
    'trackly_report_apply_observations',
    'Bulk-report up to 20 redacted, batch-bound ATS mechanics or scenario-coverage observations in one request. Never include answer values, addresses, contact data, OTPs, or page content.',
    {
      observations: z.array(z.object({
        runId: z.number().int().min(1),
        batchId: z.number().int().min(1),
        memberId: z.number().int().min(1),
        inspectionEpoch: z.number().int().min(0),
        leaseToken: z.string().min(1).max(1024),
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
      })).min(1).max(APPLY_BATCH_MAX_BULK_MUTATIONS),
    },
    wrapTool(
      async (params) => apiRequest(
        'POST',
        '/api/jobscout/apply/observations/bulk',
        params,
        false,
        false,
        MCP_USER_AGENT
      ),
      'Failed to report bulk apply observations'
    )
  );

  server.tool(
    'trackly_record_application_outcome',
    'Record review readiness or a user-confirmed outcome. Mark submitted only after a success page or explicit user confirmation.',
    {
      runId: z.number().int().min(1),
      batchId: z.number().int().min(1).optional(),
      memberId: z.number().int().min(1).optional(),
      inspectionEpoch: z.number().int().min(0).optional(),
      leaseToken: z.string().min(1).max(1024).optional(),
      outcome: z.enum(['review_ready', 'submitted', 'failed', 'blocked']),
      confirmation: z.enum(['user_confirmation', 'success_page']).optional(),
    },
    wrapTool(async ({ runId, ...body }) => apiRequest('POST', `/api/jobscout/apply/runs/${runId}/outcome`, body, false, false, MCP_USER_AGENT), 'Failed to record application outcome')
  );

  server.tool(
    'trackly_record_application_outcomes',
    'Bulk-record up to 20 leased, batch-bound review or user-confirmed outcomes. Each member returns recorded or conflict without hiding sibling results.',
    {
      outcomes: z.array(z.object({
        runId: z.number().int().min(1),
        batchId: z.number().int().min(1),
        memberId: z.number().int().min(1),
        inspectionEpoch: z.number().int().min(0),
        leaseToken: z.string().min(1).max(1024),
        outcome: z.enum(['review_ready', 'submitted', 'failed', 'blocked']),
        confirmation: z.enum(['user_confirmation', 'success_page']).optional(),
      })).min(1).max(APPLY_BATCH_MAX_BULK_MUTATIONS),
    },
    wrapTool(
      async (params) => apiRequest(
        'POST',
        '/api/jobscout/apply/outcomes/bulk',
        params,
        false,
        false,
        MCP_USER_AGENT
      ),
      'Failed to record bulk application outcomes'
    )
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
      resumeId: z.number().int().min(1),
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
        text: 'Compatibility and batch gate: require Trackly Apply protocol 3.3.1 or newer and skill 4.2.2 or newer for every new frozen batch. Protocol 3.2 remains valid for the explicit legacy single-run workflow. Recover the active frozen batch before creating another, including for a one-job request. Do not fetch or select from the queue until active-batch recovery proves that no active batch exists; any later generic queue-first instruction applies only to the legacy 3.2 single-run workflow. Claim its lease, keep membership/order fixed, inspect all members before asking one grouped packet of questions, bind each initial or recovered browser surface to the same run and exact backend URL, and discard older-epoch evidence. If a bound start returns a transport failure, a non-access HTTP 5xx response, or an error explicitly marked retryable true, preserve the frozen member and browser state, refetch the same active batch, renew its lease, and retry the same complete binding exactly once. Route maintenance_mode or planned_maintenance through maintenance recovery without consuming that retry. Surface controlled-access/request errors marked retryable false and every other HTTP 4xx response unchanged; never retry or relabel them as an outage. After the one retryable failure still fails, preserve the unchanged frozen member as the durable resume point, continue siblings, and never checkpoint the pre-run failure or detach it into an unbound legacy run. Require one exact batch resume approval plus immediate local proof before each attachment; ordinary member-version checkpoints do not revoke unchanged resume-content approval. If no form in a truth-certified subset exposes a resume control, certify truth with resumeDependency not_applicable and no resume identity. After durable review-ready checkpoints, truth-certify and hand off the exact complete subset that is currently review-ready without waiting for needs-input members. Keep unresolved members frozen and resumable; when another member becomes ready later, create a fresh certification for the then-current complete review-ready subset. After manual Submit, keep submission request, success-page or explicit user-confirmation, provider receipt, and three-part surface-close proof separate and redacted. Treat submission reconciliation as a durable commit gate: keep the confirmation tab open until a refetch proves member lifecycle submitted and Trackly job state applied_confirmed.',
      },
    }, {
      role: 'user',
      content: {
        type: 'text',
        text: 'Fetch the Trackly Apply protocol, profile onboarding, profile, and approved queue. Resolve missing answers with me. Treat required completeness separately from optional reusable coverage and employer-specific contextual questions. Before starting anything, stop on every non-null executionBlocker and every manual_only item. Start only the selected approved queue item, require major(run.protocolVersion) === major(protocol.version), require protocol.compatibleSkillMajor === 4, preserve the stored version for a resumed run, and require its provider, atsCapability, required scenarios, and originPolicy to match the queue preflight. Reclaim semantic browser control, verify the exact job/run/tab binding, hash that value-free binding, and report the same-run browser_ready attestation with committed=true. Before entering private data, require the visible company and role to match the run binding and, when available, the requisition identifier to match the stored job URL. When job_identity_match is required, report a value-free committed scenario_coverage attestation only after that visible identity check passes; never include the company, role, URL, requisition identifier, page text, or any profile value in that observation. On exact-origin fallback, revalidate the frozen company, role, and available requisition identity after every navigation or redirect and before entering any additional private data. Normalize every page, redirect, and data-receiving iframe URL; accept an exact authorized origin or hostname only when host === allowedDomain or host.endsWith("." + allowedDomain), never by substring or page text. When originPolicy.verification is trackly_employer_source_exact_origin, authorize only the exact origin in authorizedOrigins: never promote it to a host suffix and never carry it across a redirect or iframe origin change. For every other vendor-hosted ATS policy, require both originPolicy.tenantRule and originPolicy.verifiedAtsTenant to be non-null or stop before private data entry. Execute the backend-owned originPolicy.tenantRule exactly after every redirect or data-receiving iframe change, including its extraction, exact-host-depth, locale, percent-decoding, normalization, and fail-closed semantics, then require the normalized result to equal originPolicy.verifiedAtsTenant; never invent or reinterpret a strategy token. Obey every capability stop condition. Determine whether the form has a semantically identified Resume or CV attachment control. Only when that specific control exists, prepare the run-bound resume locally with that browser surface and binding hash, show me its exact path, filename, size, SHA-256, run, and expiration, and obtain my explicit confirmation. Treat cover-letter, portfolio, transcript, and other supporting-document controls separately according to the profile and protocol; never upload a resume to them. Immediately before attaching the resume, use the local verifier to validate the signed proof, recompute hash and size, check expiration, and lock the file read-only. Fill every visible field whose answer is already known, including optional fields, before asking one grouped packet for the remaining unknowns. Use real semantic UI actions and the provider playbook for Greenhouse, Ashby, HiBob, or the active capability; after every select, radio, checkbox, masked input, and upload, verify the committed DOM or accessibility state and that any related required error disappeared. Then sweep all required fields, duplicate contact values, correction banners, and the final consent control. Report a same-run passed or corrected scenario_coverage observation with committed=true for every backend-required scenario except browser_reclaim, which is satisfied only by browser_ready with the binding hash. Before every review_ready outcome, also report value-free committed critical_contact_integrity and manual_submit_boundary evidence; never include contact values, answers, page text, or local paths. If a required or universal review scenario cannot pass, record blocked rather than review_ready. Stop before Submit. If maintenance interrupts the run, retain the run and browser context, wait for the advertised window, refetch protocol, queue, and profile state, and resume the existing agent_browser run. Never start a duplicate run, blindly retry a mutation, enter credentials or verification codes, evade human verification, or click Submit.',
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
}

module.exports = {
  registerApplyTools,
};
