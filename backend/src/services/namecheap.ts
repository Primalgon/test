import { XMLParser } from 'fast-xml-parser';

/**
 * Namecheap API client.
 *
 * IMPORTANT — read before wiring this in:
 *
 * 1. Namecheap requires every calling IP to be whitelisted in your account,
 *    and it returns XML, not JSON. Cloudflare Workers have no stable egress
 *    IP, so this module MUST NOT be imported by the Worker. It runs from
 *    scripts/provision.ts on a host with a fixed IP — your n8n box, a small
 *    VPS, or a GitHub Actions runner behind a static-IP proxy.
 * 2. Domain registration costs real money on every successful call. The
 *    `dryRun` flag exists so the pipeline can be exercised end to end without
 *    buying domains; leave it on until you have watched a full run.
 * 3. Sandbox and production are different hosts AND different accounts. Test
 *    against sandbox first; credentials are not shared between them.
 */
export interface NamecheapConfig {
  apiUser: string;
  apiKey: string;
  username: string;
  clientIp: string;       // must match the whitelisted IP exactly
  sandbox?: boolean;
  dryRun?: boolean;
}

const HOST = (sandbox?: boolean) =>
  sandbox ? 'https://api.sandbox.namecheap.com/xml.response' : 'https://api.namecheap.com/xml.response';

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

async function call(cfg: NamecheapConfig, command: string, params: Record<string, string>) {
  const qs = new URLSearchParams({
    ApiUser: cfg.apiUser,
    ApiKey: cfg.apiKey,
    UserName: cfg.username,
    ClientIp: cfg.clientIp,
    Command: command,
    ...params,
  });

  const res = await fetch(`${HOST(cfg.sandbox)}?${qs}`, { method: 'GET' });
  const xml = await res.text();
  const parsed = parser.parse(xml);
  const response = parsed?.ApiResponse;

  if (!response || response['@_Status'] !== 'OK') {
    const errors = response?.Errors?.Error;
    const list = Array.isArray(errors) ? errors : errors ? [errors] : [];
    const message = list.map((e: any) => `${e['@_Number']}: ${e['#text'] ?? e}`).join('; ') || 'unknown error';
    throw new Error(`Namecheap ${command} failed -> ${message}`);
  }
  return response.CommandResponse;
}

export async function checkAvailability(cfg: NamecheapConfig, domains: string[]) {
  const r = await call(cfg, 'namecheap.domains.check', { DomainList: domains.join(',') });
  const raw = r.DomainCheckResult;
  const list = Array.isArray(raw) ? raw : [raw];
  return list.map((d: any) => ({
    domain: d['@_Domain'] as string,
    available: d['@_Available'] === 'true',
    isPremium: d['@_IsPremiumName'] === 'true',
    premiumPrice: d['@_PremiumRegistrationPrice'] ? Number(d['@_PremiumRegistrationPrice']) : null,
  }));
}

export interface RegistrantContact {
  firstName: string; lastName: string; address1: string; city: string;
  stateProvince: string; postalCode: string; country: string; phone: string; emailAddress: string;
  organizationName?: string;
}

/**
 * Namecheap wants the same contact block repeated for Registrant, Tech, Admin
 * and AuxBilling. Omitting any one of them fails with an opaque error.
 */
function contactParams(c: RegistrantContact): Record<string, string> {
  const roles = ['Registrant', 'Tech', 'Admin', 'AuxBilling'];
  const out: Record<string, string> = {};
  for (const role of roles) {
    out[`${role}FirstName`] = c.firstName;
    out[`${role}LastName`] = c.lastName;
    out[`${role}Address1`] = c.address1;
    out[`${role}City`] = c.city;
    out[`${role}StateProvince`] = c.stateProvince;
    out[`${role}PostalCode`] = c.postalCode;
    out[`${role}Country`] = c.country;
    out[`${role}Phone`] = c.phone;          // must be +NNN.NNNNNNNNNN
    out[`${role}EmailAddress`] = c.emailAddress;
    if (c.organizationName) out[`${role}OrganizationName`] = c.organizationName;
  }
  return out;
}

export async function registerDomain(cfg: NamecheapConfig, opts: {
  domain: string; years?: number; contact: RegistrantContact; whoisGuard?: boolean;
}) {
  if (cfg.dryRun) {
    return { domain: opts.domain, registered: false, dryRun: true, chargedAmount: 0 };
  }
  const r = await call(cfg, 'namecheap.domains.create', {
    DomainName: opts.domain,
    Years: String(opts.years ?? 1),
    AddFreeWhoisguard: opts.whoisGuard === false ? 'no' : 'yes',
    WGEnabled: opts.whoisGuard === false ? 'no' : 'yes',
    ...contactParams(opts.contact),
  });
  const result = r.DomainCreateResult;
  return {
    domain: result['@_Domain'] as string,
    registered: result['@_Registered'] === 'true',
    dryRun: false,
    chargedAmount: Number(result['@_ChargedAmount'] ?? 0),
    orderId: result['@_OrderID'],
  };
}

/** Point the domain at Cloudflare's nameservers. This is the handoff step. */
export async function setCustomNameservers(cfg: NamecheapConfig, domain: string, nameservers: string[]) {
  const [sld, ...rest] = domain.split('.');
  if (cfg.dryRun) return { domain, updated: false, dryRun: true };
  const r = await call(cfg, 'namecheap.domains.dns.setCustom', {
    SLD: sld!,
    TLD: rest.join('.'),
    Nameservers: nameservers.join(','),
  });
  return { domain, updated: r.DomainDNSSetCustomResult?.['@_Updated'] === 'true', dryRun: false };
}

export async function setRegistrarLock(cfg: NamecheapConfig, domain: string, lock: boolean) {
  if (cfg.dryRun) return { dryRun: true };
  return call(cfg, 'namecheap.domains.setRegistrarLock', {
    DomainName: domain, LockAction: lock ? 'LOCK' : 'UNLOCK',
  });
}
