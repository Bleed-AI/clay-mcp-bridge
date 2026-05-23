#!/usr/bin/env node
/**
 * Clay MCP Bridge v1.0.0
 *
 * HTTP-based MCP server for Clay API access.
 * Gets session cookie from ClayMate Chrome extension, makes API calls directly.
 *
 * API Reference: https://claydocs.claygenius.io/
 * Forked and maintained by Bleed-AI: https://github.com/Bleed-AI/clay-mcp-bridge
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const readline = require('readline');

const PORT = parseInt(process.env.CLAYMATE_PORT, 10) || 12306;
const HOST = '127.0.0.1';
const VERSION = '1.0.0';
const CLAY_API_BASE = 'api.clay.com';

// =============================================================================
// SESSION MANAGEMENT
// =============================================================================

let sessionCookie = null;
let sessionUpdatedAt = null;

/**
 * Make an HTTPS request to Clay API
 */
function clayRequest(method, apiPath, body = null, contentType = 'application/json') {
  return new Promise((resolve, reject) => {
    if (!sessionCookie) {
      reject(new Error('No session cookie. Please ensure ClayMate extension is running and you are logged into Clay.'));
      return;
    }

    const options = {
      hostname: CLAY_API_BASE,
      port: 443,
      path: apiPath,
      method,
      headers: {
        'Content-Type': contentType,
        'Accept': 'application/json',
        'Cookie': sessionCookie,
        'X-Clay-Frontend-Version': '2025.02.02'
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (res.statusCode >= 400) {
            reject(new Error(json.message || json.error || `HTTP ${res.statusCode}`));
          } else {
            resolve(json);
          }
        } catch (e) {
          if (res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
          } else {
            resolve(data);
          }
        }
      });
    });

    req.on('error', reject);

    if (body) {
      const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
      req.setHeader('Content-Length', Buffer.byteLength(bodyStr));
      req.write(bodyStr);
    }
    req.end();
  });
}

// =============================================================================
// HTTP SERVER
// =============================================================================

const app = express();
app.use(express.json());

// CORS - only allow localhost origins (Claude Code connects via HTTP, not browser)
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && (origin.startsWith('http://127.0.0.1') || origin.startsWith('http://localhost') || origin.startsWith('chrome-extension://'))) {
    res.header('Access-Control-Allow-Origin', origin);
  }
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Rate limit /session endpoint (5 requests per minute per IP)
const sessionRateLimit = {};
function checkSessionRateLimit(ip) {
  const now = Date.now();
  const windowMs = 60000;
  if (!sessionRateLimit[ip]) sessionRateLimit[ip] = [];
  sessionRateLimit[ip] = sessionRateLimit[ip].filter(t => now - t < windowMs);
  if (sessionRateLimit[ip].length >= 5) return false;
  sessionRateLimit[ip].push(now);
  return true;
}

// =============================================================================
// SESSION ENDPOINT
// =============================================================================

app.post('/session', (req, res) => {
  if (!checkSessionRateLimit(req.ip)) {
    return res.status(429).json({ error: 'Rate limit exceeded. Max 5 requests per minute.' });
  }
  const { cookie } = req.body;
  if (cookie) {
    sessionCookie = cookie;
    sessionUpdatedAt = new Date().toISOString();
    console.error(`[Bridge] Session cookie updated at ${sessionUpdatedAt}`);
    res.json({ success: true, updatedAt: sessionUpdatedAt });
  } else {
    res.status(400).json({ error: 'Missing cookie in request body' });
  }
});

app.get('/session', (req, res) => {
  res.json({ hasSession: !!sessionCookie, updatedAt: sessionUpdatedAt });
});

// =============================================================================
// MCP ENDPOINTS
// =============================================================================

app.post('/mcp', async (req, res) => {
  const mcpRequest = req.body;
  console.error(`[Bridge] MCP Request: ${mcpRequest.method}`);

  const acceptsSSE = req.headers.accept?.includes('text/event-stream');

  try {
    const response = await handleMcpRequest(mcpRequest);

    if (acceptsSSE) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.write(`event: message\ndata: ${JSON.stringify(response)}\n\n`);
      res.end();
    } else {
      res.json(response);
    }
  } catch (error) {
    const errorResponse = {
      jsonrpc: '2.0',
      id: mcpRequest.id,
      error: { code: -32603, message: error.message }
    };
    res.json(errorResponse);
  }
});

app.get('/mcp', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.write(`event: endpoint\ndata: /mcp\n\n`);
  const keepAlive = setInterval(() => res.write(': keepalive\n\n'), 15000);
  req.on('close', () => clearInterval(keepAlive));
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    version: VERSION,
    hasSession: !!sessionCookie,
    sessionUpdatedAt
  });
});

// =============================================================================
// MCP REQUEST HANDLER
// =============================================================================

async function handleMcpRequest(request) {
  switch (request.method) {
    case 'initialize':
      return {
        jsonrpc: '2.0',
        id: request.id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'clay-mcp-bridge', version: VERSION }
        }
      };

    case 'notifications/initialized':
      return null;

    case 'tools/list':
      return { jsonrpc: '2.0', id: request.id, result: { tools: getToolsList() } };

    case 'tools/call':
      return await handleToolCall(request);

    case 'resources/list':
      return { jsonrpc: '2.0', id: request.id, result: { resources: [] } };

    case 'prompts/list':
      return { jsonrpc: '2.0', id: request.id, result: { prompts: [] } };

    default:
      return {
        jsonrpc: '2.0',
        id: request.id,
        error: { code: -32601, message: `Method not found: ${request.method}` }
      };
  }
}

function getToolsList() {
  return [
    {
      name: 'clay_get_status',
      description: 'Check ClayMate connection status.',
      inputSchema: { type: 'object', properties: {} }
    },
    {
      name: 'clay_list_workspaces',
      description: 'List all Clay workspaces you have access to.',
      inputSchema: { type: 'object', properties: {} }
    },
    {
      name: 'clay_get_table',
      description: 'Get details about a Clay table including its columns/schema.',
      inputSchema: {
        type: 'object',
        properties: { tableId: { type: 'string', description: 'The table ID (e.g., "t_abc123")' } },
        required: ['tableId']
      }
    },
    {
      name: 'clay_get_rows',
      description: 'Fetch record IDs from a Clay table view.',
      inputSchema: {
        type: 'object',
        properties: {
          tableId: { type: 'string', description: 'The table ID' },
          viewId: { type: 'string', description: 'The view ID (e.g., "gv_xxx")' }
        },
        required: ['tableId', 'viewId']
      }
    },
    {
      name: 'clay_add_row',
      description: 'Add a new row to a Clay table.',
      inputSchema: {
        type: 'object',
        properties: {
          tableId: { type: 'string', description: 'The table ID' },
          cells: { type: 'object', description: 'Cell data as key-value pairs (column ID to value)' }
        },
        required: ['tableId']
      }
    },
    {
      name: 'clay_run_enrichment',
      description: 'Run an enrichment column on records in a table view.',
      inputSchema: {
        type: 'object',
        properties: {
          tableId: { type: 'string', description: 'The table ID' },
          viewId: { type: 'string', description: 'The view ID' },
          fieldId: { type: 'string', description: 'The enrichment column/field ID' },
          numRecords: { type: 'number', description: 'Number of records to enrich (omit for all)' }
        },
        required: ['tableId', 'viewId', 'fieldId']
      }
    },
    {
      name: 'clay_count_rows',
      description: 'Get the number of rows in a Clay table.',
      inputSchema: {
        type: 'object',
        properties: { tableId: { type: 'string', description: 'The table ID' } },
        required: ['tableId']
      }
    },
    {
      name: 'clay_list_sources',
      description: 'List all data sources configured for a Clay table.',
      inputSchema: {
        type: 'object',
        properties: { tableId: { type: 'string', description: 'The table ID' } },
        required: ['tableId']
      }
    },
    // === NEW TOOLS ===
    {
      name: 'clay_list_resources',
      description: 'List all resources (tables, workbooks, folders) in a workspace. Does not include tables nested within folders/workbooks.',
      inputSchema: {
        type: 'object',
        properties: { workspaceId: { type: 'number', description: 'The workspace ID (numeric)' } },
        required: ['workspaceId']
      }
    },
    {
      name: 'clay_search_resources',
      description: 'Search for resources (tables, workbooks, folders) by name within a workspace.',
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: { type: 'number', description: 'The workspace ID (numeric)' },
          query: { type: 'string', description: 'Search query string' }
        },
        required: ['workspaceId', 'query']
      }
    },
    {
      name: 'clay_create_folder',
      description: 'Create a new folder in a workspace.',
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: { type: 'number', description: 'The workspace ID (numeric)' },
          name: { type: 'string', description: 'Folder name' },
          parentFolderId: { type: 'string', description: 'Parent folder ID (optional, for nested folders)' }
        },
        required: ['workspaceId', 'name']
      }
    },
    {
      name: 'clay_delete_folder',
      description: 'Delete a folder from a workspace.',
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: { type: 'number', description: 'The workspace ID (numeric)' },
          folderId: { type: 'string', description: 'The folder ID to delete' },
          isPermanentDelete: { type: 'boolean', description: 'If true, permanently delete. If false, move to trash (default).' }
        },
        required: ['workspaceId', 'folderId']
      }
    },
    {
      name: 'clay_create_workbook',
      description: 'Create a new workbook in a workspace.',
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: { type: 'number', description: 'The workspace ID (numeric)' },
          name: { type: 'string', description: 'Workbook name' },
          folderId: { type: 'string', description: 'Parent folder ID (optional)' }
        },
        required: ['workspaceId', 'name']
      }
    },
    {
      name: 'clay_delete_workbook',
      description: 'Delete a workbook from a workspace.',
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: { type: 'number', description: 'The workspace ID (numeric)' },
          workbookId: { type: 'string', description: 'The workbook ID to delete' },
          isPermanentDelete: { type: 'boolean', description: 'If true, permanently delete. If false, move to trash (default).' }
        },
        required: ['workspaceId', 'workbookId']
      }
    },
    {
      name: 'clay_delete_rows',
      description: 'Delete specific rows from a table by record IDs.',
      inputSchema: {
        type: 'object',
        properties: {
          tableId: { type: 'string', description: 'The table ID' },
          recordIds: { type: 'array', items: { type: 'string' }, description: 'Array of record IDs to delete' }
        },
        required: ['tableId', 'recordIds']
      }
    },
    {
      name: 'clay_delete_all_rows',
      description: 'Delete all rows from a specific view in a table.',
      inputSchema: {
        type: 'object',
        properties: {
          tableId: { type: 'string', description: 'The table ID' },
          viewId: { type: 'string', description: 'The view ID - all rows visible in this view will be deleted' }
        },
        required: ['tableId', 'viewId']
      }
    },
    {
      name: 'clay_add_webhook',
      description: 'Add a webhook source to a table.',
      inputSchema: {
        type: 'object',
        properties: {
          tableId: { type: 'string', description: 'The table ID' },
          workspaceId: { type: 'number', description: 'The workspace ID (numeric)' },
          name: { type: 'string', description: 'Name for the webhook source' }
        },
        required: ['tableId', 'workspaceId']
      }
    },
    {
      name: 'clay_delete_source',
      description: 'Delete a data source from a table.',
      inputSchema: {
        type: 'object',
        properties: {
          sourceId: { type: 'string', description: 'The source ID to delete' },
          deleteRecords: { type: 'boolean', description: 'If true, also delete records from this source. Default false.' }
        },
        required: ['sourceId']
      }
    },
    {
      name: 'clay_list_owners',
      description: 'Get list of users and their permissions in a workspace.',
      inputSchema: {
        type: 'object',
        properties: { workspaceId: { type: 'number', description: 'The workspace ID (numeric)' } },
        required: ['workspaceId']
      }
    },
    {
      name: 'clay_get_credit_usage',
      description: 'Get workspace credit usage report for a time range.',
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: { type: 'number', description: 'The workspace ID (numeric)' },
          startDate: { type: 'string', description: 'Start date (ISO format, e.g., 2024-01-01)' },
          endDate: { type: 'string', description: 'End date (ISO format, e.g., 2024-01-31)' }
        },
        required: ['workspaceId', 'startDate', 'endDate']
      }
    },
    {
      name: 'clay_list_integrations',
      description: 'List all connected integrations/app accounts in a workspace.',
      inputSchema: {
        type: 'object',
        properties: { workspaceId: { type: 'number', description: 'The workspace ID (numeric)' } },
        required: ['workspaceId']
      }
    },
    {
      name: 'clay_export_table_data',
      description: 'Export row data from a Clay table as JSON to a file. IMPORTANT: this pages through the table\'s default view (`/views/{viewId}/records`) which returns rows in the VIEW\'S native sort order — typically oldest-first. With sort="asc" + maxRows=N you get the OLDEST N rows; freshly-written rows will NOT appear unless you fetch the entire table OR use sort="desc" (which fetches count first, then pages the tail window). For write-verification (confirming a specific row landed), prefer `filterByColumnValue` which post-filters after pagination, OR sort="desc" with a maxRows ≥ the number of new rows you\'re looking for. Always writes full data to a JSON file and returns a summary with file path, sample rows, and column list.',
      inputSchema: {
        type: 'object',
        properties: {
          tableId: { type: 'string', description: 'The table ID (e.g., "t_abc123")' },
          maxRows: { type: 'number', description: 'Maximum number of rows to export. Default: all rows.' },
          columns: { type: 'array', items: { type: 'string' }, description: 'Only include these columns (by name). Default: all columns.' },
          sort: { type: 'string', enum: ['asc', 'desc'], description: 'Row order. "asc" (default) pages from offset=0 — view\'s native order, typically oldest-first. "desc" calls clay_count_rows first then pages the LAST maxRows window — newest-first within the view; use this when verifying recently-written rows.' },
          filterByColumnValue: {
            type: 'object',
            description: 'Post-filter rows after pagination: only keep rows where the named column starts with (or equals) the given value. Useful for write-verification (e.g. find rows whose Callback Id starts with "cb2c-"). Note this still pages the full window first — combine with sort="desc" + reasonable maxRows for efficient verification.',
            properties: {
              columnName: { type: 'string' },
              value: { type: 'string', description: 'Substring/prefix to match (case-insensitive). Empty string matches all non-null values.' },
              match: { type: 'string', enum: ['prefix', 'equals', 'contains'], description: 'Match mode. Default: "prefix".' }
            },
            required: ['columnName', 'value']
          }
        },
        required: ['tableId']
      }
    }
  ];
}

async function handleToolCall(request) {
  const { name, arguments: args } = request.params;
  console.error(`[Bridge] Tool call: ${name}`);

  try {
    let result;

    switch (name) {
      case 'clay_get_status':
        result = {
          version: VERSION,
          hasSession: !!sessionCookie,
          sessionUpdatedAt,
          note: sessionCookie
            ? 'Ready - session cookie received from ClayMate extension'
            : 'No session. Make sure the ClayMate Chrome extension is running and you are logged into Clay.'
        };
        break;

      case 'clay_list_workspaces':
        // Correct endpoint: /v3/my-workspaces
        result = await clayRequest('GET', '/v3/my-workspaces');
        break;

      case 'clay_get_table':
        if (!args?.tableId) throw new Error('tableId is required');
        result = await clayRequest('GET', `/v3/tables/${args.tableId}`);
        break;

      case 'clay_get_rows':
        if (!args?.tableId) throw new Error('tableId is required');
        if (!args?.viewId) throw new Error('viewId is required');
        // Correct endpoint: /v3/tables/{TABLE_ID}/views/{VIEW_ID}/records/ids
        result = await clayRequest('GET', `/v3/tables/${args.tableId}/views/${args.viewId}/records/ids`);
        break;

      case 'clay_add_row':
        if (!args?.tableId) throw new Error('tableId is required');
        // Correct endpoint: POST /v3/tables/{TABLE_ID}/records
        // Body: {"records": [{"id": "uuid", "cells": {}}]}
        const rowId = `row_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const addBody = {
          records: [{
            id: rowId,
            cells: args.cells || {}
          }]
        };
        result = await clayRequest('POST', `/v3/tables/${args.tableId}/records`, addBody);
        break;

      case 'clay_run_enrichment':
        if (!args?.tableId) throw new Error('tableId is required');
        if (!args?.viewId) throw new Error('viewId is required');
        if (!args?.fieldId) throw new Error('fieldId is required');
        // Correct endpoint: PATCH /v3/tables/{TABLE_ID}/run
        // Content-Type: application/x-www-form-urlencoded with JSON body
        const runBody = {
          fieldIds: [args.fieldId],
          runRecords: {
            viewIdTopRecords: {
              viewId: args.viewId,
              ...(args.numRecords ? { numRecords: args.numRecords } : {})
            }
          },
          callerName: 'API'
        };
        result = await clayRequest('PATCH', `/v3/tables/${args.tableId}/run`, JSON.stringify(runBody), 'application/x-www-form-urlencoded');
        break;

      case 'clay_count_rows':
        if (!args?.tableId) throw new Error('tableId is required');
        // Correct endpoint: GET /v3/tables/{TABLE_ID}/count
        result = await clayRequest('GET', `/v3/tables/${args.tableId}/count`);
        break;

      case 'clay_list_sources':
        if (!args?.tableId) throw new Error('tableId is required');
        // Correct endpoint: GET /v3/sources?tableId={TABLE_ID}
        result = await clayRequest('GET', `/v3/sources?tableId=${args.tableId}`);
        break;

      // === NEW TOOL HANDLERS ===
      // API docs: https://claydocs.claygenius.io/

      case 'clay_list_resources':
        if (!args?.workspaceId) throw new Error('workspaceId is required');
        // POST /v3/workspaces/{WORKSPACE_ID}/resources_v2/
        result = await clayRequest('POST', `/v3/workspaces/${args.workspaceId}/resources_v2/`, {
          parentResource: null
        });
        break;

      case 'clay_search_resources':
        if (!args?.workspaceId) throw new Error('workspaceId is required');
        if (!args?.query) throw new Error('query is required');
        // POST /v3/workspaces/{WORKSPACE_ID}/resources_v2/ with filters
        result = await clayRequest('POST', `/v3/workspaces/${args.workspaceId}/resources_v2/`, {
          parentResource: null,
          filters: { q: args.query }
        });
        break;

      case 'clay_create_folder':
        if (!args?.workspaceId) throw new Error('workspaceId is required');
        if (!args?.name) throw new Error('name is required');
        // POST /v3/workspaces/{WORKSPACE_ID}/folders
        result = await clayRequest('POST', `/v3/workspaces/${args.workspaceId}/folders`, {
          name: args.name
        });
        break;

      case 'clay_delete_folder':
        if (!args?.workspaceId) throw new Error('workspaceId is required');
        if (!args?.folderId) throw new Error('folderId is required');
        // DELETE /v3/workspaces/{WORKSPACE_ID}/resources/
        result = await clayRequest('DELETE', `/v3/workspaces/${args.workspaceId}/resources/`, {
          folderIds: [args.folderId],
          tableIds: [],
          workbookIds: [],
          isPermanentDelete: args.isPermanentDelete || false
        });
        break;

      case 'clay_create_workbook':
        if (!args?.workspaceId) throw new Error('workspaceId is required');
        if (!args?.name) throw new Error('name is required');
        // POST /v3/workbooks
        result = await clayRequest('POST', '/v3/workbooks', {
          name: args.name,
          workspaceId: args.workspaceId,
          settings: { isAutoRun: args.isAutoRun || false }
        });
        break;

      case 'clay_delete_workbook':
        if (!args?.workspaceId) throw new Error('workspaceId is required');
        if (!args?.workbookId) throw new Error('workbookId is required');
        // DELETE /v3/workspaces/{WORKSPACE_ID}/resources/
        result = await clayRequest('DELETE', `/v3/workspaces/${args.workspaceId}/resources/`, {
          workbookIds: [args.workbookId],
          tableIds: [],
          folderIds: [],
          isPermanentDelete: args.isPermanentDelete || false
        });
        break;

      case 'clay_delete_rows':
        if (!args?.tableId) throw new Error('tableId is required');
        if (!args?.recordIds || !Array.isArray(args.recordIds)) throw new Error('recordIds array is required');
        // DELETE /v3/tables/{TABLE_ID}/records
        result = await clayRequest('DELETE', `/v3/tables/${args.tableId}/records`, {
          recordIds: args.recordIds
        });
        break;

      case 'clay_delete_all_rows': {
        if (!args?.tableId) throw new Error('tableId is required');
        if (!args?.viewId) throw new Error('viewId is required');
        // Clay's API has no deleteAll flag — fetch all IDs from the view, then delete explicitly
        const idsResult = await clayRequest('GET', `/v3/tables/${args.tableId}/views/${args.viewId}/records/ids`);
        const allIds = idsResult?.results || idsResult || [];
        if (allIds.length === 0) {
          result = { deleted: 0, message: 'No rows to delete' };
        } else {
          result = await clayRequest('DELETE', `/v3/tables/${args.tableId}/records`, { recordIds: allIds });
        }
        break;
      }

      case 'clay_add_webhook':
        if (!args?.tableId) throw new Error('tableId is required');
        if (!args?.workspaceId) throw new Error('workspaceId is required');
        // PATCH /v3/tables/{TABLE_ID} with sourceSettings.addSource
        const webhookSourceId = `s_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        result = await clayRequest('PATCH', `/v3/tables/${args.tableId}`, {
          tableSettings: {},
          fieldGroupMap: {},
          sourceSettings: {
            addSource: {
              id: webhookSourceId,
              name: args.name || 'Webhook',
              workspaceId: args.workspaceId,
              typeSettings: { type: 'webhook' }
            }
          }
        });
        break;

      case 'clay_delete_source':
        if (!args?.sourceId) throw new Error('sourceId is required');
        // DELETE /v3/sources/{SOURCE_ID} with deleteRecords flag
        result = await clayRequest('DELETE', `/v3/sources/${args.sourceId}`, {
          deleteRecords: args.deleteRecords || false
        });
        break;

      case 'clay_list_owners':
        if (!args?.workspaceId) throw new Error('workspaceId is required');
        // GET /v3/workspaces/{WORKSPACE_ID}/permissions
        result = await clayRequest('GET', `/v3/workspaces/${args.workspaceId}/permissions`);
        break;

      case 'clay_get_credit_usage':
        if (!args?.workspaceId) throw new Error('workspaceId is required');
        if (!args?.startDate) throw new Error('startDate is required');
        if (!args?.endDate) throw new Error('endDate is required');
        // GET /v3/credit-reporting/{WORKSPACE_ID}/creditReportType/workspace?timeRange[startTime]=X&timeRange[endTime]=Y
        const startTime = new Date(args.startDate).toISOString();
        const endTime = new Date(args.endDate).toISOString();
        result = await clayRequest('GET', `/v3/credit-reporting/${args.workspaceId}/creditReportType/workspace?timeRange[startTime]=${encodeURIComponent(startTime)}&timeRange[endTime]=${encodeURIComponent(endTime)}`);
        break;

      case 'clay_list_integrations':
        if (!args?.workspaceId) throw new Error('workspaceId is required');
        // GET /v3/workspaces/{WORKSPACE_ID}/app-accounts
        result = await clayRequest('GET', `/v3/workspaces/${args.workspaceId}/app-accounts`);
        break;

      case 'clay_export_table_data':
        if (!args?.tableId) throw new Error('tableId is required');
        result = await exportTableData(args.tableId, args.maxRows, args.columns, {
          sort: args.sort,
          filterByColumnValue: args.filterByColumnValue
        });
        break;

      default:
        throw new Error(`Unknown tool: ${name}`);
    }

    return {
      jsonrpc: '2.0',
      id: request.id,
      result: {
        content: [{
          type: 'text',
          text: typeof result === 'string' ? result : JSON.stringify(result, null, 2)
        }]
      }
    };

  } catch (error) {
    return {
      jsonrpc: '2.0',
      id: request.id,
      result: {
        content: [{ type: 'text', text: `Error: ${error.message}` }],
        isError: true
      }
    };
  }
}

// =============================================================================
// TABLE DATA EXPORT
// =============================================================================

/**
 * Export table data with human-readable column names.
 * Always writes full data to /tmp file. Returns compact summary with file path
 * and sample rows so the LLM has context without burning tokens on full data.
 * Use Read tool on the file path to inspect specific portions.
 */
async function exportTableData(tableId, maxRows, filterColumns, opts = {}) {
  const BATCH_SIZE = 100;
  const BATCH_DELAY = 150;
  const SAMPLE_ROWS = 3;
  const sort = (opts.sort === 'desc') ? 'desc' : 'asc';
  const filterByColumnValue = opts.filterByColumnValue || null;

  // 1. Fetch table schema for field mapping and table name
  console.error(`[Bridge] Exporting data from table ${tableId}...`);
  const tableData = await clayRequest('GET', `/v3/tables/${tableId}`);

  const fields = tableData.fields || tableData.table?.fields || [];
  if (!fields || fields.length === 0) {
    throw new Error('No fields found in table');
  }

  const table = tableData.table || tableData;
  const tableName = table.name || tableId;

  // Get default view ID for record fetching
  const viewId = table.firstViewId || (table.views && table.views[0]?.id);
  if (!viewId) {
    throw new Error('No view found in table — cannot fetch records without a view ID');
  }

  // Build field ID → column name map (skip system fields)
  const fieldIdToName = {};
  const allColumnNames = [];
  for (const f of fields) {
    if (f.id === 'f_created_at' || f.id === 'f_updated_at') continue;
    fieldIdToName[f.id] = f.name;
    allColumnNames.push(f.name);
  }

  // Apply column filter if specified
  const filterSet = filterColumns ? new Set(filterColumns) : null;
  const columnNames = filterSet
    ? allColumnNames.filter(c => filterSet.has(c))
    : allColumnNames;

  if (filterSet && columnNames.length === 0) {
    throw new Error(`No matching columns found. Available: ${allColumnNames.join(', ')}`);
  }

  // 2. Paginate through records using view-scoped endpoint.
  // The view returns rows in its native sort order (typically oldest-first by created_at).
  // For sort="desc" we fetch the total row count first, then page the LAST maxRows window
  // so the caller sees the most-recent rows (within the view's native order, then reversed).
  let startOffset = 0;
  let rowsToFetch = maxRows || Infinity;
  if (sort === 'desc') {
    try {
      const countResp = await clayRequest('GET', `/v3/tables/${tableId}/count`);
      const totalCount = (typeof countResp === 'number')
        ? countResp
        : (countResp.count ?? countResp.rowCount ?? countResp.total ?? countResp.totalRecords ?? null);
      if (typeof totalCount === 'number' && Number.isFinite(totalCount)) {
        if (maxRows && maxRows < totalCount) {
          startOffset = totalCount - maxRows;
        }
        console.error(`[Bridge] sort=desc: total rows=${totalCount}, starting at offset=${startOffset}`);
      } else {
        console.error(`[Bridge] sort=desc: could not parse row count from response, falling back to offset=0 (results will be oldest-first)`);
      }
    } catch (e) {
      console.error(`[Bridge] sort=desc: count call failed (${e.message}), falling back to offset=0`);
    }
  }

  const allRows = [];
  let offset = startOffset;
  let hasMore = true;

  while (hasMore) {
    const limit = maxRows ? Math.min(BATCH_SIZE, rowsToFetch - allRows.length) : BATCH_SIZE;
    if (limit <= 0) break;

    console.error(`[Bridge] Fetching records offset=${offset} limit=${limit} from view ${viewId}...`);
    const batch = await clayRequest('GET', `/v3/tables/${tableId}/views/${viewId}/records?limit=${limit}&offset=${offset}`);

    // Handle response — Clay returns {results: [...]}
    const records = Array.isArray(batch) ? batch : (batch.records || batch.results || batch.data || []);

    if (records.length === 0) {
      hasMore = false;
      break;
    }

    // 3. Map field IDs to column names for each record
    for (const record of records) {
      const cells = record.cells || record.fields || record;
      const row = {};

      for (const [fieldId, cellData] of Object.entries(cells)) {
        const colName = fieldIdToName[fieldId];
        if (!colName) continue;
        if (filterSet && !filterSet.has(colName)) continue;

        // Clay cells are {value: ..., metadata: {...}} — extract just the value
        // Cells with only metadata (no value key) are treated as null
        if (cellData && typeof cellData === 'object' && 'metadata' in cellData) {
          row[colName] = 'value' in cellData ? cellData.value : null;
        } else {
          row[colName] = cellData;
        }
      }

      allRows.push(row);
    }

    offset += records.length;

    if (records.length < limit) {
      hasMore = false;
    }

    if (maxRows && allRows.length >= maxRows) {
      hasMore = false;
    }

    // Rate limit delay between batches
    if (hasMore) {
      await new Promise(r => setTimeout(r, BATCH_DELAY));
    }
  }

  // Reverse for sort=desc so newest-first within the fetched window
  if (sort === 'desc') {
    allRows.reverse();
  }

  // Apply optional post-pagination value filter (case-insensitive)
  let finalRows = allRows;
  let filterNote = '';
  if (filterByColumnValue && filterByColumnValue.columnName) {
    const col = filterByColumnValue.columnName;
    const needle = String(filterByColumnValue.value ?? '').toLowerCase();
    const mode = filterByColumnValue.match || 'prefix';
    const before = allRows.length;
    finalRows = allRows.filter(r => {
      const v = r[col];
      if (v === null || v === undefined) return false;
      const s = String(v).toLowerCase();
      if (mode === 'equals') return s === needle;
      if (mode === 'contains') return s.includes(needle);
      return s.startsWith(needle); // prefix
    });
    filterNote = ` | filterByColumnValue ${col} ${mode} "${filterByColumnValue.value}": ${finalRows.length}/${before} matched`;
  }

  console.error(`[Bridge] Exported ${finalRows.length} rows from "${tableName}" (sort=${sort})${filterNote}`);

  // 4. Always write to file in exports/clay/ within the repo
  const output = {
    tableId,
    tableName,
    exportedAt: new Date().toISOString(),
    sort,
    fetchedWindow: { startOffset, fetchedRowCount: allRows.length },
    rowCount: finalRows.length,
    columns: columnNames,
    rows: finalRows
  };

  const json = JSON.stringify(output, null, 2);
  const exportDir = path.join(__dirname, '..', '..', '..', 'exports', 'clay');
  if (!fs.existsSync(exportDir)) fs.mkdirSync(exportDir, { recursive: true });
  const timestamp = Date.now();
  const filePath = path.join(exportDir, `clay-export-${tableId}-${timestamp}.json`);
  fs.writeFileSync(filePath, json);
  console.error(`[Bridge] Export (${(json.length / 1024).toFixed(1)}KB) written to ${filePath}`);

  // 5. Return compact summary with sample rows
  const sampleRows = finalRows.slice(0, SAMPLE_ROWS);

  return {
    filePath,
    tableId,
    tableName,
    sort,
    fetchedWindow: { startOffset, fetchedRowCount: allRows.length },
    rowCount: finalRows.length,
    columns: columnNames,
    fileSizeKB: Math.round(json.length / 1024),
    sampleRows,
    note: `Full data written to ${filePath}. Use Read tool to inspect. ${filterSet ? `Filtered to ${columnNames.length}/${allColumnNames.length} columns. ` : ''}${filterNote ? filterNote.replace(/^ \| /, '') + '. ' : ''}sort=${sort}${sort === 'asc' ? ' (oldest-first; recent rows may be beyond maxRows window — re-run with sort:"desc" to verify recent writes)' : ' (newest-first within fetched window)'}.`
  };
}

// =============================================================================
// INSTALLATION
// =============================================================================

function install(extensionId) {
  const platform = os.platform();
  const home = os.homedir();

  let manifestPath;
  if (platform === 'darwin') {
    manifestPath = path.join(home, 'Library/Application Support/Google/Chrome/NativeMessagingHosts/com.bleed-ai.clay-mcp-bridge.json');
  } else if (platform === 'linux') {
    manifestPath = path.join(home, '.config/google-chrome/NativeMessagingHosts/com.bleed-ai.clay-mcp-bridge.json');
  } else {
    console.error('Unsupported platform:', platform);
    process.exit(1);
  }

  const manifest = {
    name: 'com.bleed-ai.clay-mcp-bridge',
    description: 'Clay MCP Bridge',
    path: path.join(__dirname, 'clay-mcp-bridge.sh'),
    type: 'stdio',
    allowed_origins: extensionId
      ? [`chrome-extension://${extensionId}/`]
      : ['chrome-extension://EXTENSION_ID_HERE/']
  };

  const dir = path.dirname(manifestPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log('Installed:', manifestPath);
}

// =============================================================================
// INTERACTIVE SETUP & PROCESS MANAGEMENT
// =============================================================================

const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const CYAN = '\x1b[36m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';
const CHECK = `${GREEN}\u2713${RESET}`;

const LAUNCHD_LABEL = 'com.bleed-ai.clay-mcp-bridge';
const PLIST_DIR = path.join(os.homedir(), 'Library/LaunchAgents');
const PLIST_PATH = path.join(PLIST_DIR, `${LAUNCHD_LABEL}.plist`);
const LOG_DIR = path.join(os.homedir(), '.clay-mcp-bridge');
const LOG_PATH = path.join(LOG_DIR, 'bridge.log');
const ERR_LOG_PATH = path.join(LOG_DIR, 'bridge.err.log');

function prompt(rl, question) {
  return new Promise(resolve => rl.question(question, resolve));
}

function banner() {
  console.log('');
  console.log(`${BOLD}  Clay MCP Bridge${RESET} ${DIM}v${VERSION}${RESET}`);
  console.log(`${DIM}  Connect Clay to Claude Code${RESET}`);
  console.log('');
}

// =============================================================================
// LAUNCHD / PROCESS MANAGEMENT
// =============================================================================

function getNodePath() {
  const { execSync } = require('child_process');
  try {
    return execSync('which node', { encoding: 'utf8' }).trim();
  } catch {
    return '/usr/local/bin/node';
  }
}

function installLaunchdPlist() {
  const platform = os.platform();
  if (platform !== 'darwin') return false; // macOS only — Windows users: see README for .bat startup approach

  const nodePath = getNodePath();
  const scriptPath = path.resolve(__filename);

  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
  if (!fs.existsSync(PLIST_DIR)) fs.mkdirSync(PLIST_DIR, { recursive: true });

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${scriptPath}</string>
    <string>--server</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${LOG_PATH}</string>
  <key>StandardErrorPath</key>
  <string>${ERR_LOG_PATH}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin:${path.dirname(nodePath)}</string>
  </dict>
</dict>
</plist>`;

  fs.writeFileSync(PLIST_PATH, plist);
  return true;
}

function launchdStart() {
  const { execSync } = require('child_process');
  try {
    // Unload first in case it's already loaded (ignore errors)
    try { execSync(`launchctl unload "${PLIST_PATH}" 2>/dev/null`); } catch {}
    execSync(`launchctl load "${PLIST_PATH}"`);
    return true;
  } catch (error) {
    return false;
  }
}

function launchdStop() {
  const { execSync } = require('child_process');
  try {
    execSync(`launchctl unload "${PLIST_PATH}"`);
    return true;
  } catch {
    return false;
  }
}

function getBridgePid() {
  const { execSync } = require('child_process');
  try {
    const output = execSync(`lsof -ti :${PORT} 2>/dev/null`, { encoding: 'utf8' }).trim();
    return output ? output.split('\n')[0] : null;
  } catch {
    return null;
  }
}

function checkStatus() {
  const pid = getBridgePid();
  const plistExists = fs.existsSync(PLIST_PATH);

  banner();

  if (pid) {
    console.log(`  ${CHECK} Bridge is ${GREEN}running${RESET} (PID ${pid})`);
    console.log(`    Listening on http://${HOST}:${PORT}/mcp`);
  } else {
    console.log(`  ${RED}Bridge is not running${RESET}`);
  }

  if (plistExists) {
    console.log(`  ${CHECK} Auto-start on login ${GREEN}enabled${RESET}`);
  } else {
    console.log(`  ${DIM}  Auto-start on login not configured${RESET}`);
  }

  console.log(`\n${DIM}  Logs: ${LOG_PATH}${RESET}`);
  console.log('');
}

function stopBridge() {
  banner();

  const stopped = launchdStop();
  const pid = getBridgePid();

  if (pid) {
    try {
      process.kill(parseInt(pid), 'SIGTERM');
      console.log(`  ${CHECK} Bridge stopped (was PID ${pid})`);
    } catch {
      console.log(`  ${YELLOW}Could not stop process ${pid}${RESET}`);
    }
  } else if (stopped) {
    console.log(`  ${CHECK} Bridge stopped`);
  } else {
    console.log(`  ${DIM}Bridge was not running${RESET}`);
  }
  console.log('');
}

function restartBridge() {
  banner();

  if (!fs.existsSync(PLIST_PATH)) {
    console.log(`  ${RED}No launchd plist found. Run setup first.${RESET}\n`);
    process.exit(1);
  }

  launchdStop();
  // Brief pause to let the port free up
  const { execSync } = require('child_process');
  try { execSync('sleep 1'); } catch {}

  if (launchdStart()) {
    const pid = getBridgePid();
    console.log(`  ${CHECK} Bridge restarted${pid ? ` (PID ${pid})` : ''}`);
  } else {
    console.log(`  ${RED}Failed to restart. Check logs: ${LOG_PATH}${RESET}`);
  }
  console.log('');
}

function uninstallBridge() {
  banner();

  launchdStop();

  if (fs.existsSync(PLIST_PATH)) {
    fs.unlinkSync(PLIST_PATH);
    console.log(`  ${CHECK} Removed launchd plist`);
  }

  // Remove native messaging host manifest
  const home = os.homedir();
  const nativeManifest = os.platform() === 'darwin'
    ? path.join(home, 'Library/Application Support/Google/Chrome/NativeMessagingHosts/com.bleed-ai.clay-mcp-bridge.json')
    : path.join(home, '.config/google-chrome/NativeMessagingHosts/com.bleed-ai.clay-mcp-bridge.json');

  if (fs.existsSync(nativeManifest)) {
    fs.unlinkSync(nativeManifest);
    console.log(`  ${CHECK} Removed native messaging host`);
  }

  console.log(`  ${CHECK} Uninstalled`);
  console.log(`\n${DIM}  To remove from Claude Code: claude mcp remove claymate${RESET}`);
  console.log(`${DIM}  Windows users: delete your .bat shortcut from shell:startup${RESET}`);
  console.log('');
}

// =============================================================================
// INTERACTIVE SETUP
// =============================================================================

async function setup() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  banner();

  // Step 1: Extension ID
  console.log(`${BOLD}Step 1/3: Chrome Extension${RESET}`);
  console.log(`${DIM}  Find your Extension ID at chrome://extensions (enable Developer Mode)${RESET}`);
  console.log('');

  const extensionId = (await prompt(rl, `  Extension ID: `)).trim();

  if (!extensionId) {
    console.log(`\n${RED}  No extension ID provided. Exiting.${RESET}\n`);
    rl.close();
    process.exit(1);
  }

  // Validate format (Chrome extension IDs are 32 lowercase alpha chars)
  if (!/^[a-z]{32}$/.test(extensionId)) {
    console.log(`\n${YELLOW}  Warning: "${extensionId}" doesn't look like a Chrome extension ID.${RESET}`);
    console.log(`${DIM}  Expected 32 lowercase letters (e.g., abcdefghijklmnopabcdefghijklmnop)${RESET}`);
    const cont = (await prompt(rl, `  Continue anyway? (y/N): `)).trim().toLowerCase();
    if (cont !== 'y' && cont !== 'yes') {
      rl.close();
      process.exit(1);
    }
  }

  // Install native messaging host
  console.log('');
  console.log(`  Installing native messaging host...`);
  install(extensionId);
  console.log(`  ${CHECK} Native messaging host installed`);

  // Step 2: Coding agent
  console.log('');
  console.log(`${BOLD}Step 2/3: Coding Agent${RESET}`);
  console.log('');
  console.log(`  1) Claude Code`);
  console.log(`  ${DIM}2) Codex [Coming Soon]${RESET}`);
  console.log('');

  const agentChoice = (await prompt(rl, `  Select agent (1): `)).trim() || '1';

  if (agentChoice === '2') {
    console.log(`\n${YELLOW}  Codex support is coming soon. Choose Claude Code for now.${RESET}\n`);
    rl.close();
    process.exit(0);
  }

  if (agentChoice !== '1') {
    console.log(`\n${RED}  Invalid selection. Exiting.${RESET}\n`);
    rl.close();
    process.exit(1);
  }

  // Step 3: Register MCP with Claude Code
  console.log('');
  console.log(`${BOLD}Step 3/3: Register MCP Server${RESET}`);
  console.log('');
  console.log(`  Will run: ${DIM}claude mcp add claymate --transport http http://127.0.0.1:${PORT}/mcp${RESET}`);
  console.log('');

  const confirm = (await prompt(rl, `  Proceed? (Y/n): `)).trim().toLowerCase();

  if (confirm === 'n' || confirm === 'no') {
    console.log(`\n${DIM}  Skipped. You can add it manually later:${RESET}`);
    console.log(`${DIM}  claude mcp add claymate --transport http http://127.0.0.1:${PORT}/mcp${RESET}\n`);
  } else {
    const { execSync } = require('child_process');
    try {
      execSync(`claude mcp add claymate --transport http http://127.0.0.1:${PORT}/mcp`, { stdio: 'inherit' });
      console.log(`  ${CHECK} MCP server registered with Claude Code`);
    } catch (error) {
      console.log(`\n${YELLOW}  Could not register automatically. Add manually:${RESET}`);
      console.log(`${DIM}  claude mcp add claymate --transport http http://127.0.0.1:${PORT}/mcp${RESET}`);
    }
  }

  rl.close();

  // Install launchd plist and start the bridge as a background service
  console.log('');

  if (os.platform() === 'darwin') {
    installLaunchdPlist();

    if (launchdStart()) {
      // Give launchd a moment to spin up the process
      await new Promise(r => setTimeout(r, 1000));
      const pid = getBridgePid();
      console.log(`  ${CHECK} Bridge server started${pid ? ` (PID ${pid})` : ''}`);
      console.log(`  ${CHECK} Auto-start on login enabled`);
    } else {
      console.log(`  ${YELLOW}Could not start via launchd. Starting in foreground...${RESET}`);
      startServer();
    }
  } else {
    // Linux: start detached process
    const { spawn } = require('child_process');
    const nodePath = getNodePath();

    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    const out = fs.openSync(LOG_PATH, 'a');
    const err = fs.openSync(ERR_LOG_PATH, 'a');

    const child = spawn(nodePath, [__filename, '--server'], {
      detached: true,
      stdio: ['ignore', out, err]
    });
    child.unref();
    console.log(`  ${CHECK} Bridge server started (PID ${child.pid})`);
    console.log(`  ${DIM}Note: On Linux, the bridge won't auto-start on reboot.${RESET}`);
    console.log(`  ${DIM}Run this command again or add to your startup scripts.${RESET}`);
  }

  // Done
  console.log('');
  console.log(`${GREEN}${BOLD}  Setup complete!${RESET}`);
  console.log('');
  console.log(`  Open ${CYAN}app.clay.com${RESET} in any Chrome window with ClayMate installed.`);
  console.log(`  The extension will sync your session automatically.`);
  console.log('');
  console.log(`${DIM}  Manage the bridge:${RESET}`);
  console.log(`${DIM}    clay-mcp-bridge --status     Check if running${RESET}`);
  console.log(`${DIM}    clay-mcp-bridge --stop       Stop the bridge${RESET}`);
  console.log(`${DIM}    clay-mcp-bridge --restart    Restart the bridge${RESET}`);
  console.log(`${DIM}    clay-mcp-bridge --uninstall  Remove everything${RESET}`);
  console.log('');
}

// =============================================================================
// SERVER START (foreground — used by launchd and --server flag)
// =============================================================================

function startServer() {
  app.listen(PORT, HOST, () => {
    console.error(`[Bridge] Clay MCP Bridge v${VERSION} (Bleed-AI)`);
    console.error(`[Bridge] HTTP server: http://${HOST}:${PORT}/mcp`);
    console.error(`[Bridge] Waiting for session cookie from ClayMate extension...`);
  });
}

// =============================================================================
// MAIN
// =============================================================================

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  banner();
  console.log(`  ${BOLD}Usage:${RESET} clay-mcp-bridge [option]\n`);
  console.log(`  ${DIM}(no args)${RESET}       Interactive setup wizard`);
  console.log(`  ${DIM}--server${RESET}        Run bridge in foreground (used by launchd)`);
  console.log(`  ${DIM}--status${RESET}        Check if bridge is running`);
  console.log(`  ${DIM}--stop${RESET}          Stop the bridge`);
  console.log(`  ${DIM}--restart${RESET}       Restart the bridge`);
  console.log(`  ${DIM}--uninstall${RESET}     Remove bridge, plist, and native host`);
  console.log(`  ${DIM}--install [id]${RESET}  Install native messaging host only`);
  console.log('');
  process.exit(0);
}

if (args.includes('--status')) {
  checkStatus();
  process.exit(0);
}

if (args.includes('--stop')) {
  stopBridge();
  process.exit(0);
}

if (args.includes('--restart')) {
  restartBridge();
  process.exit(0);
}

if (args.includes('--uninstall')) {
  uninstallBridge();
  process.exit(0);
}

if (args.includes('--install')) {
  const idx = args.indexOf('--install') + 1;
  const extId = args[idx] && !args[idx].startsWith('--') ? args[idx] : null;
  install(extId);
  process.exit(0);
}

if (args.includes('--server')) {
  // Foreground mode — used by launchd plist and direct invocation
  startServer();
} else {
  // Default: interactive setup flow
  setup().catch(err => {
    console.error(`${RED}Setup failed:${RESET}`, err.message);
    process.exit(1);
  });
}
