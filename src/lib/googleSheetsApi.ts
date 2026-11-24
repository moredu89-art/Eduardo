import { clearGoogleAccessToken, getGoogleAccessToken } from './googleAuth';

export interface DriveSpreadsheetFile {
  id: string;
  name: string;
  modifiedTime?: string;
  webViewLink?: string;
}

export interface SpreadsheetMetadata {
  spreadsheetId: string;
  title: string;
  spreadsheetUrl?: string;
  sheets: Array<{
    sheetId: number;
    title: string;
    rowCount?: number;
    columnCount?: number;
  }>;
}

function escapeSheetTitle(sheetTitle: string): string {
  const escaped = sheetTitle.replace(/'/g, "''");
  return `'${escaped}'`;
}

async function googleFetch<T>(url: string, init: RequestInit = {}): Promise<T> {
  const token = getGoogleAccessToken();
  if (!token) {
    throw new Error('Sesión de Google no iniciada o expirada. Conéctese con Google.');
  }

  const headers = new Headers(init.headers || {});
  headers.set('Authorization', `Bearer ${token}`);
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const res = await fetch(url, { ...init, headers });
  if (res.status === 401) {
    clearGoogleAccessToken();
    throw new Error('El token de Google expiró. Vuelva a iniciar sesión con Google.');
  }

  if (!res.ok) {
    let message = `Error de Google API (${res.status})`;
    try {
      const err = (await res.json()) as { error?: { message?: string } };
      if (err?.error?.message) message = err.error.message;
    } catch {
      // ignore non-JSON body
    }
    throw new Error(message);
  }

  return (await res.json()) as T;
}

export function extractSpreadsheetId(input: string): string {
  const trimmed = input.trim();
  const match = trimmed.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (match && match[1]) return match[1];
  return trimmed;
}

export async function listDriveSpreadsheets(searchQuery = ''): Promise<DriveSpreadsheetFile[]> {
  const qParts = [
    "mimeType='application/vnd.google-apps.spreadsheet'",
    'trashed=false',
  ];
  if (searchQuery.trim()) {
    const safeSearch = searchQuery.trim().replace(/'/g, "\\'");
    qParts.push(`name contains '${safeSearch}'`);
  }

  const params = new URLSearchParams({
    q: qParts.join(' and '),
    fields: 'files(id,name,modifiedTime,webViewLink)',
    orderBy: 'modifiedTime desc',
    pageSize: '30',
  });

  const data = await googleFetch<{ files?: DriveSpreadsheetFile[] }>(
    `https://www.googleapis.com/drive/v3/files?${params.toString()}`
  );
  return data.files || [];
}

export async function getSpreadsheetMetadata(spreadsheetId: string): Promise<SpreadsheetMetadata> {
  const cleanId = extractSpreadsheetId(spreadsheetId);
  const data = await googleFetch<{
    spreadsheetId: string;
    spreadsheetUrl?: string;
    properties?: { title?: string };
    sheets?: Array<{
      properties?: {
        sheetId?: number;
        title?: string;
        gridProperties?: { rowCount?: number; columnCount?: number };
      };
    }>;
  }>(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
      cleanId
    )}?fields=spreadsheetId,spreadsheetUrl,properties.title,sheets.properties`
  );

  return {
    spreadsheetId: data.spreadsheetId,
    spreadsheetUrl: data.spreadsheetUrl,
    title: data.properties?.title || 'Sin título',
    sheets: (data.sheets || []).map((s, idx) => ({
      sheetId: s.properties?.sheetId ?? idx,
      title: s.properties?.title || `Hoja ${idx + 1}`,
      rowCount: s.properties?.gridProperties?.rowCount,
      columnCount: s.properties?.gridProperties?.columnCount,
    })),
  };
}

export async function readSheetValues(
  spreadsheetId: string,
  sheetTitle: string
): Promise<{ headers: string[]; rows: Record<string, unknown>[]; rawValues: string[][] }> {
  const cleanId = extractSpreadsheetId(spreadsheetId);
  const range = encodeURIComponent(`${escapeSheetTitle(sheetTitle)}!A1:ZZ5000`);
  const data = await googleFetch<{ values?: string[][] }>(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(cleanId)}/values/${range}`
  );

  const rawValues = data.values || [];
  if (rawValues.length === 0) {
    return { headers: [], rows: [], rawValues: [] };
  }

  const headers = rawValues[0].map((h, i) => String(h || '').trim() || `Columna_${i + 1}`);
  const rows = rawValues.slice(1).map((rowArr) => {
    const obj: Record<string, unknown> = {};
    headers.forEach((header, idx) => {
      obj[header] = rowArr[idx] !== undefined ? rowArr[idx] : '';
    });
    return obj;
  });

  return { headers, rows, rawValues };
}

export async function createGoogleSpreadsheet(params: {
  title: string;
  sheetTitle: string;
  values: (string | number)[][];
}): Promise<{ spreadsheetId: string; spreadsheetUrl: string }> {
  const created = await googleFetch<{
    spreadsheetId: string;
    spreadsheetUrl: string;
  }>('https://sheets.googleapis.com/v4/spreadsheets', {
    method: 'POST',
    body: JSON.stringify({
      properties: { title: params.title },
      sheets: [{ properties: { title: params.sheetTitle } }],
    }),
  });

  if (params.values.length > 0) {
    const range = encodeURIComponent(`${escapeSheetTitle(params.sheetTitle)}!A1`);
    await googleFetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
        created.spreadsheetId
      )}/values/${range}?valueInputOption=USER_ENTERED`,
      {
        method: 'PUT',
        body: JSON.stringify({
          range: `${escapeSheetTitle(params.sheetTitle)}!A1`,
          majorDimension: 'ROWS',
          values: params.values,
        }),
      }
    );
  }

  return created;
}

export async function overwriteSheetValues(params: {
  spreadsheetId: string;
  sheetTitle: string;
  values: (string | number)[][];
}): Promise<{ updatedRows: number }> {
  const cleanId = extractSpreadsheetId(params.spreadsheetId);
  const fullRange = encodeURIComponent(`${escapeSheetTitle(params.sheetTitle)}!A:ZZ`);

  await googleFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
      cleanId
    )}/values/${fullRange}:clear`,
    {
      method: 'POST',
      body: JSON.stringify({}),
    }
  );

  const startRange = encodeURIComponent(`${escapeSheetTitle(params.sheetTitle)}!A1`);
  const updateRes = await googleFetch<{ updatedRows?: number }>(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
      cleanId
    )}/values/${startRange}?valueInputOption=USER_ENTERED`,
    {
      method: 'PUT',
      body: JSON.stringify({
        range: `${escapeSheetTitle(params.sheetTitle)}!A1`,
        majorDimension: 'ROWS',
        values: params.values,
      }),
    }
  );

  return { updatedRows: updateRes.updatedRows ?? params.values.length };
}
