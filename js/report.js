// The diagnostic report: everything needed to understand what happened
// between this page and a radio, gathered into one JSON document that the
// user sees in full before choosing to send or download it.
//
// Nothing is redacted, deliberately: Brian chose an explicit opt-in that
// includes the whole codeplug (callsign, DMR IDs, contacts), because a
// codeplug that decodes wrongly can only be fixed by looking at its bytes.
// The consent text says so, and says what happens to it (used only to fix
// the programmer, deleted after 90 days).

import { VERSION } from './version.js';
import { decode } from './codeplug/codec.js';
import { summarize } from './codeplug/checks.js';
import { codeplugFile, openGD77ToBackup } from './files.js';
import { toBase64 } from './util.js';

export const REPORT_FORMAT = 'gd77-web-diagnostic-report';
export const REPORT_VERSION = 1;
export const MAX_REPORT_BYTES = 3 * 1024 * 1024; // the server's limit

const hexOf = b => (b ? Array.from(b, x => x.toString(16).padStart(2, '0')).join(' ') : null);
const vidPid = (v, p) => (v === undefined || v === null ? null : `${v.toString(16).padStart(4, '0')}:${p.toString(16).padStart(4, '0')}`);

// Browser facts. userAgentData's high-entropy values need a promise, so
// this is collected separately and handed to buildReport().
export async function collectEnvironment(nav = globalThis.navigator) {
  const env = {
    userAgent: nav?.userAgent ?? null,
    platform: nav?.platform ?? null,
    language: nav?.language ?? null,
    hasSerial: !!nav?.serial,
    hasHid: !!nav?.hid,
    userAgentData: null,
  };
  const uad = nav?.userAgentData;
  if (uad) {
    env.userAgentData = { brands: uad.brands, mobile: uad.mobile, platform: uad.platform };
    try { Object.assign(env.userAgentData, await uad.getHighEntropyValues(['platformVersion', 'architecture', 'model', 'fullVersionList'])); }
    catch { /* not offered; the low-entropy values are enough */ }
  }
  return env;
}

function deviceSummary(device) {
  if (!device) return null;
  if ('productId' in device && 'vendorId' in device) {
    return {
      api: 'webhid',
      usb: vidPid(device.vendorId, device.productId),
      productName: device.productName ?? null,
      // WebHID exposes the parsed report descriptor as collections, not the raw descriptor.
      collections: (device.collections || []).map(c => ({
        usagePage: c.usagePage, usage: c.usage,
        outputReports: (c.outputReports || []).map(r => ({ reportId: r.reportId, bytes: (r.items || []).reduce((n, it) => n + it.reportSize * it.reportCount, 0) / 8 })),
        inputReports: (c.inputReports || []).map(r => ({ reportId: r.reportId, bytes: (r.items || []).reduce((n, it) => n + it.reportSize * it.reportCount, 0) / 8 })),
        featureReports: (c.featureReports || []).map(r => ({ reportId: r.reportId })),
      })),
    };
  }
  const info = typeof device.getInfo === 'function' ? device.getInfo() : {};
  // Web Serial gives no product or manufacturer strings, only the USB IDs.
  return { api: 'webserial', usb: vidPid(info.usbVendorId, info.usbProductId), info };
}

function radioSummary(radio) {
  if (!radio) return null;
  if (radio.firmware === 'stock') {
    const id = radio.idRaw;
    return {
      firmware: 'stock',
      idHex: hexOf(id),
      idAscii: id ? String.fromCharCode(...id).replace(/[^\x20-\x7e]/g, '.') : null,
      hidReportMode: { outputReportId: radio.outId ?? null, outputBytes: radio.outLen ?? null },
      readRepliesEchoRequest: radio.echoChecked,
    };
  }
  return {
    firmware: radio.firmware,
    writeType: radio.writeType ? String.fromCharCode(radio.writeType) : null,
    firmwareInfoHex: hexOf(radio.infoRaw),
  };
}

function codeplugOf(image) {
  if (!image) return null;
  if (image.fw === 'stock' || image.fw === 'stock-v2') return { fw: image.fw, format: 'dmrconfig-img', base64: toBase64(codeplugFile(image).data) };
  return { fw: image.fw, format: 'gd77backup', backup: JSON.parse(openGD77ToBackup(image)) };
}

function errorOf(e) {
  if (!e) return null;
  return { name: e.name, message: e.message, radioState: e.radioState ?? null, addr: e.addr ?? null, stack: e.stack ?? null, cause: e.cause ? { name: e.cause.name, message: e.cause.message } : null };
}

export function buildReport({ session, environment, simulated, user = {}, error = null, now = new Date(), pageUrl = null, firmware = null }) {
  const d = session.diag || {};
  const radio = d.radio;
  let summary = null;
  if (d.readImage) {
    try { summary = summarize(decode(d.readImage)); }
    catch (e) { summary = { decodeError: e.message }; }
  }
  const t = radio?.trace?.snapshot() ?? null;
  return {
    format: REPORT_FORMAT,
    formatVersion: REPORT_VERSION,
    createdAt: now.toISOString(),
    simulated: !!simulated,
    page: { version: VERSION, url: pageUrl },
    environment,
    user: { name: user.name || '', email: user.email || '', message: user.message || '' },
    transport: { kind: d.kind, device: deviceSummary(d.device) },
    radio: { identified: d.info ? { model: d.info.model, firmware: d.info.firmware, family: d.info.family ?? null, info: d.info.info ?? null } : null, ...{ detail: radioSummary(radio) } },
    session: {
      log: session.logLines.slice(),
      timings: t?.timings ?? [],
      counters: t?.counters ?? null,
      exchangesTotal: t?.exchangesTotal ?? 0,
      exchanges: t?.exchanges ?? [],
    },
    error: errorOf(error ?? d.error),
    codeplug: { read: codeplugOf(d.readImage), attemptedWrite: codeplugOf(d.writeImage) },
    summary,
    // The Firmware tab's session (files' hashes and sizes, bootloader
    // string, plan, last USB exchanges), when it has been used.
    firmware,
  };
}

// What the consent preview lists: each part of the report and its size.
export function reportSizes(report) {
  const json = JSON.stringify(report);
  const parts = Object.keys(report).map(k => ({ part: k, bytes: JSON.stringify(report[k] ?? null).length }));
  return { total: json.length, parts, tooBig: json.length > MAX_REPORT_BYTES };
}

// Short line for notifications and the server's listing.
export function reportHeadline(report) {
  const id = report.radio?.identified;
  return `${id?.model ?? 'no radio'} ${id?.firmware ?? ''} ${report.error ? 'ERROR: ' + report.error.message : 'ok'}`.replace(/\s+/g, ' ').trim();
}
