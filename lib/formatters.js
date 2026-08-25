'use strict';

const c = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  green: '\x1b[32m', yellow: '\x1b[33m', blue: '\x1b[34m',
  magenta: '\x1b[35m', cyan: '\x1b[36m', red: '\x1b[31m',
};

// Decide whether to emit ANSI color for a given output stream.
// Precedence (no-color.org + the common FORCE_COLOR convention):
//   NO_COLOR present and non-empty → never color
//   FORCE_COLOR set and not "0"/"false" → always color
//   otherwise → only when the stream is a TTY
function shouldColor(stream = process.stdout) {
  if ('NO_COLOR' in process.env && process.env.NO_COLOR !== '') return false;
  if (process.env.FORCE_COLOR && !['0', 'false'].includes(process.env.FORCE_COLOR)) return true;
  return Boolean(stream && stream.isTTY);
}

function color(name, text, stream = process.stdout) {
  if (!shouldColor(stream)) return String(text);
  return `${c[name] || ''}${text}${c.reset}`;
}

function isJSON() {
  return !process.stdout.isTTY || process.argv.includes('--json');
}

function formatFundingLine(company) {
  if (!company) return null;
  const parts = [];
  const series = company.fundingSeries || company.fundingStage;
  if (series) {
    let badge = series;
    if (company.valuationMillions) {
      const val = company.valuationMillions;
      badge += ` · ${val >= 1000 ? `$${(val / 1000).toFixed(val >= 10000 ? 0 : 1)}B` : `$${val.toFixed(0)}M`}`;
    }
    parts.push(badge);
  }
  if (company.fundingStage && company.fundingSeries) {
    parts.push(company.fundingStage);
  }
  return parts.length > 0 ? parts.join(' | ') : null;
}

function validCalendarDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value
    ? null
    : value;
}

function isoCalendarDay(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

function sourceCalendarDay(job, kind) {
  const meta = kind === 'posted'
    ? job && job.sourceDateMeta && job.sourceDateMeta.original
    : kind === 'reposted'
      ? job && job.sourceDateMeta && job.sourceDateMeta.repost
      : null;
  return meta && meta.precision === 'day'
    ? validCalendarDay(meta.calendarDay)
    : null;
}

function jobDatePresentation(job = {}) {
  const kind = ['posted', 'reposted', 'found'].includes(job.displayDateKind)
    ? job.displayDateKind
    : null;
  const displayDay = kind
    ? sourceCalendarDay(job, kind) || isoCalendarDay(job.displayDate)
    : null;
  if (kind && displayDay) {
    return {
      label: { posted: 'Posted', reposted: 'Reposted', found: 'Found' }[kind],
      value: displayDay,
    };
  }
  const postedDay = isoCalendarDay(job.postedAt || job.posted_at);
  if (postedDay) return { label: 'Posted', value: postedDay };
  return { label: 'Found', value: isoCalendarDay(job.firstSeenAt || job.first_seen_at) || 'unknown' };
}

function jobDateDetailLines(job = {}) {
  const lines = [];
  const projectedKind = ['posted', 'reposted', 'found'].includes(job.displayDateKind)
    ? job.displayDateKind
    : null;
  const projectedDay = projectedKind
    ? sourceCalendarDay(job, projectedKind) || isoCalendarDay(job.displayDate)
    : null;
  const originalDay = sourceCalendarDay(job, 'posted') || isoCalendarDay(job.originalPostedAt);
  const repostDay = sourceCalendarDay(job, 'reposted') || isoCalendarDay(job.repostedAt)
    || (projectedKind === 'reposted' ? projectedDay : null);
  const legacyPostedDay = isoCalendarDay(job.postedAt || job.posted_at);
  const foundDay = isoCalendarDay(job.firstSeenAt || job.first_seen_at);
  if (originalDay) lines.push(`Posted: ${originalDay}`);
  else if (repostDay) lines.push('Original posting date unavailable');
  else if (projectedKind === 'posted' && projectedDay) lines.push(`Posted: ${projectedDay}`);
  else if (!projectedKind && legacyPostedDay) lines.push(`Posted: ${legacyPostedDay}`);
  if (foundDay) lines.push(`Found: ${foundDay}`);
  else if (!originalDay && !repostDay) {
    const presentation = jobDatePresentation(job);
    if (presentation.value !== 'unknown') {
      lines.push(`${presentation.label}: ${presentation.value}`);
    }
  }
  if (repostDay) lines.push(`Reposted: ${repostDay}`);
  const reference = job.sourceReference;
  if (reference && reference.disambiguatesTitle === true
    && typeof reference.value === 'string' && reference.value.trim()) {
    lines.push(`Req: ${reference.value.trim()}`);
  }
  return lines;
}

function outputJobs(jobs) {
  if (isJSON()) return console.log(JSON.stringify(jobs, null, 2));
  if (!jobs || jobs.length === 0) {
    console.log(color('dim', 'No jobs found.'));
    return;
  }
  for (const job of jobs) {
    const location = job.location ? color('dim', job.location) : '';
    const companyName = job.companyName || (job.company && job.company.name) || '';
    console.log(`${color('bold', job.title)}`);
    console.log(`  ${color('blue', companyName)} | ${location}`);
    const fundingLine = formatFundingLine(job.company);
    if (fundingLine) console.log(`  ${color('magenta', fundingLine)}`);
    const date = jobDatePresentation(job);
    console.log(`  ID: ${color('dim', job.id)} | ${date.label}: ${color('dim', date.value)}`);
    if (job.jobUrl) console.log(`  ${color('dim', job.jobUrl)}`);
    console.log();
  }
}

function outputCompanies(companies) {
  if (isJSON()) return console.log(JSON.stringify(companies, null, 2));
  if (!companies || companies.length === 0) {
    console.log(color('dim', 'No companies found.'));
    return;
  }
  for (const co of companies) {
    const count = co.totalJobCount || 0;
    console.log(`${color('bold', co.name)} — ${color('cyan', count + ' jobs')}`);
    if (co.domain) console.log(`  ${color('dim', co.domain)}`);
    console.log();
  }
}

function outputStats(stats) {
  if (isJSON()) return console.log(JSON.stringify(stats, null, 2));
  console.log(color('bold', 'Trackly Stats'));
  console.log();
  if (stats.totalJobs !== undefined) console.log(`Total Jobs: ${color('cyan', stats.totalJobs)}`);
  if (stats.totalCompanies !== undefined) console.log(`Companies: ${color('cyan', stats.totalCompanies)}`);
  if (stats.appliedCount !== undefined) console.log(`Applied: ${color('green', stats.appliedCount)}`);
  if (stats.savedCount !== undefined) console.log(`Saved: ${color('yellow', stats.savedCount)}`);
  // Print any other keys
  for (const [k, v] of Object.entries(stats)) {
    if (!['totalJobs', 'totalCompanies', 'appliedCount', 'savedCount'].includes(k)) {
      console.log(`${k}: ${color('dim', JSON.stringify(v))}`);
    }
  }
}

function outputContacts(contacts) {
  if (isJSON()) return console.log(JSON.stringify(contacts, null, 2));
  if (!contacts || contacts.length === 0) {
    console.log(color('dim', 'No contacts found.'));
    return;
  }
  // Header
  console.log(
    color('bold', padRight('Name', 24)) + ' ' +
    color('bold', padRight('Title', 28)) + ' ' +
    color('bold', padRight('Company', 20)) + ' ' +
    color('bold', padRight('Email', 28)) + ' ' +
    color('bold', 'Status')
  );
  console.log(color('dim', '-'.repeat(110)));
  for (const contact of contacts) {
    const name = padRight(contact.name || '', 24);
    const title = padRight(contact.title || '', 28);
    const company = padRight(contact.company || '', 20);
    const email = padRight(contact.email || '', 28);
    const status = contact.status || '';
    const statusColor = status === 'active' ? 'green' : status === 'pending' ? 'yellow' : 'dim';
    console.log(
      `${name} ${title} ${company} ${email} ${color(statusColor, status)}`
    );
  }
}

function outputReferralCampaign(campaign) {
  if (isJSON()) return console.log(JSON.stringify(campaign, null, 2));
  if (!campaign) {
    console.log(color('dim', 'No campaign data.'));
    return;
  }
  console.log(color('bold', 'Referral Campaign'));
  console.log();
  if (campaign.id) console.log(`Campaign ID: ${color('cyan', campaign.id)}`);
  if (campaign.jobId) console.log(`Job ID: ${color('dim', campaign.jobId)}`);
  if (campaign.status) {
    const statusColor = campaign.status === 'active' ? 'green' : campaign.status === 'completed' ? 'blue' : 'yellow';
    console.log(`Status: ${color(statusColor, campaign.status)}`);
  }
  if (campaign.createdAt) console.log(`Created: ${color('dim', campaign.createdAt)}`);
  if (campaign.company) console.log(`Company: ${color('blue', campaign.company)}`);
  if (campaign.jobTitle) console.log(`Job: ${color('bold', campaign.jobTitle)}`);

  if (campaign.contacts && campaign.contacts.length > 0) {
    console.log();
    console.log(color('bold', 'Outreach Progress:'));
    for (const c of campaign.contacts) {
      const icon = c.status === 'sent' ? color('green', '[sent]') :
                   c.status === 'replied' ? color('cyan', '[replied]') :
                   c.status === 'pending' ? color('yellow', '[pending]') :
                   color('dim', `[${c.status || 'unknown'}]`);
      console.log(`  ${icon} ${c.name || 'Unknown'}${c.title ? ' — ' + color('dim', c.title) : ''}`);
    }
  }

  // Print any other top-level keys
  for (const [k, v] of Object.entries(campaign)) {
    if (!['id', 'jobId', 'status', 'createdAt', 'company', 'jobTitle', 'contacts'].includes(k)) {
      console.log(`${k}: ${color('dim', JSON.stringify(v))}`);
    }
  }
}

function outputNetworkBrief(brief) {
  if (isJSON()) return console.log(JSON.stringify(brief, null, 2));
  if (!brief) {
    console.log(color('dim', 'No network brief available.'));
    return;
  }
  console.log(color('bold', 'Network Brief'));
  console.log();

  if (brief.companySignal) {
    console.log(color('bold', 'Company Signal:'));
    console.log(`  ${brief.companySignal}`);
    console.log();
  }

  if (brief.recommendedMotion) {
    console.log(color('bold', 'Recommended Motion:'));
    console.log(`  ${color('cyan', brief.recommendedMotion)}`);
    console.log();
  }

  if (brief.topContact) {
    console.log(color('bold', 'Top Contact:'));
    const tc = brief.topContact;
    if (tc.name) console.log(`  Name: ${tc.name}`);
    if (tc.title) console.log(`  Title: ${color('dim', tc.title)}`);
    if (tc.company) console.log(`  Company: ${color('blue', tc.company)}`);
    if (tc.email) console.log(`  Email: ${color('cyan', tc.email)}`);
    if (tc.reason) console.log(`  Why: ${color('dim', tc.reason)}`);
    console.log();
  }

  if (brief.actions && brief.actions.length > 0) {
    console.log(color('bold', 'Actions:'));
    for (let i = 0; i < brief.actions.length; i++) {
      const action = brief.actions[i];
      if (typeof action === 'string') {
        console.log(`  ${color('green', (i + 1) + '.')} ${action}`);
      } else {
        console.log(`  ${color('green', (i + 1) + '.')} ${action.description || JSON.stringify(action)}`);
      }
    }
    console.log();
  }

  // Print any other top-level keys
  for (const [k, v] of Object.entries(brief)) {
    if (!['companySignal', 'recommendedMotion', 'topContact', 'actions'].includes(k)) {
      console.log(`${k}: ${color('dim', JSON.stringify(v))}`);
    }
  }
}

function outputCompanyBrief(brief) {
  if (isJSON()) return console.log(JSON.stringify(brief, null, 2));
  if (!brief) {
    console.log(color('dim', 'No brief available. Use --refresh to generate.'));
    return;
  }
  console.log(color('bold', 'Company Brief'));
  console.log();

  if (brief.companyName) console.log(`Company: ${color('blue', brief.companyName)}`);
  if (brief.summary) {
    console.log();
    console.log(color('bold', 'Summary:'));
    console.log(`  ${brief.summary}`);
  }
  if (brief.hiringTrends) {
    console.log();
    console.log(color('bold', 'Hiring Trends:'));
    console.log(`  ${brief.hiringTrends}`);
  }
  if (brief.recentNews) {
    console.log();
    console.log(color('bold', 'Recent News:'));
    if (Array.isArray(brief.recentNews)) {
      for (const item of brief.recentNews) {
        console.log(`  - ${typeof item === 'string' ? item : item.headline || JSON.stringify(item)}`);
      }
    } else {
      console.log(`  ${brief.recentNews}`);
    }
  }
  if (brief.keyPeople && brief.keyPeople.length > 0) {
    console.log();
    console.log(color('bold', 'Key People:'));
    for (const person of brief.keyPeople) {
      console.log(`  ${person.name || 'Unknown'}${person.title ? ' — ' + color('dim', person.title) : ''}`);
    }
  }
  if (brief.generatedAt) console.log(color('dim', `\nGenerated: ${brief.generatedAt}`));

  // Print any other top-level keys
  for (const [k, v] of Object.entries(brief)) {
    if (!['companyName', 'summary', 'hiringTrends', 'recentNews', 'keyPeople', 'generatedAt'].includes(k)) {
      console.log(`${k}: ${color('dim', JSON.stringify(v))}`);
    }
  }
}

function outputCompanyWorkspace(workspace) {
  if (isJSON()) return console.log(JSON.stringify(workspace, null, 2));
  if (!workspace) {
    console.log(color('dim', 'No workspace data available.'));
    return;
  }
  console.log(color('bold', 'Company Workspace'));
  console.log();

  if (workspace.companyName) console.log(`Company: ${color('blue', workspace.companyName)}`);
  if (workspace.activeJobsCount !== undefined) console.log(`Active Jobs: ${color('cyan', workspace.activeJobsCount)}`);
  if (workspace.contactsCount !== undefined) console.log(`Contacts: ${color('cyan', workspace.contactsCount)}`);

  if (workspace.hiringManagers && workspace.hiringManagers.length > 0) {
    console.log();
    console.log(color('bold', 'Hiring Managers:'));
    for (const hm of workspace.hiringManagers) {
      console.log(`  ${hm.name || 'Unknown'}${hm.title ? ' — ' + color('dim', hm.title) : ''}`);
      if (hm.email) console.log(`    ${color('cyan', hm.email)}`);
    }
  }

  if (workspace.coverageGap !== undefined) {
    console.log();
    console.log(color('bold', 'Coverage Gap:'));
    if (typeof workspace.coverageGap === 'string') {
      console.log(`  ${workspace.coverageGap}`);
    } else {
      console.log(`  ${JSON.stringify(workspace.coverageGap)}`);
    }
  }

  if (workspace.campaignStatus) {
    console.log();
    console.log(color('bold', 'Campaign Status:'));
    if (typeof workspace.campaignStatus === 'string') {
      const statusColor = workspace.campaignStatus === 'active' ? 'green' : workspace.campaignStatus === 'completed' ? 'blue' : 'yellow';
      console.log(`  ${color(statusColor, workspace.campaignStatus)}`);
    } else {
      console.log(`  ${JSON.stringify(workspace.campaignStatus)}`);
    }
  }

  if (workspace.contacts && workspace.contacts.length > 0) {
    console.log();
    console.log(color('bold', 'Contacts:'));
    for (const contact of workspace.contacts) {
      const statusColor = contact.status === 'active' ? 'green' : contact.status === 'pending' ? 'yellow' : 'dim';
      console.log(`  ${contact.name || 'Unknown'}${contact.title ? ' — ' + color('dim', contact.title) : ''} ${color(statusColor, contact.status || '')}`);
    }
  }

  // Print any other top-level keys
  for (const [k, v] of Object.entries(workspace)) {
    if (!['companyName', 'activeJobsCount', 'contactsCount', 'hiringManagers', 'coverageGap', 'campaignStatus', 'contacts'].includes(k)) {
      console.log(`${k}: ${color('dim', JSON.stringify(v))}`);
    }
  }
}

function padRight(str, len) {
  if (str.length >= len) return str.slice(0, len);
  return str + ' '.repeat(len - str.length);
}

function outputError(msg) {
  // Errors go to stderr, so gate their color on stderr's TTY-ness, not stdout's.
  console.error(color('red', `Error: ${msg}`, process.stderr));
}

module.exports = { color, shouldColor, isJSON, jobDatePresentation, jobDateDetailLines, outputJobs, outputCompanies, outputStats, outputContacts, outputReferralCampaign, outputNetworkBrief, outputCompanyBrief, outputCompanyWorkspace, outputError };
