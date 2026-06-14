"use strict";

const crypto = require("node:crypto");

const SUPABASE_URL = "https://pupwtdupqcbceahmgrwc.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_dnyeFg6dYj5fYGKhqQHWwA_-tvrSXc0";
const ALLOWED_TYPES = new Set(["message", "call"]);

let cachedGoogleToken = null;
let cachedGoogleTokenExpiresAt = 0;

function json(statusCode, payload) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    },
    body: JSON.stringify(payload)
  };
}

function cleanText(value, fallback, maxLength) {
  return String(value ?? fallback ?? "").trim().slice(0, maxLength);
}

function base64url(value) {
  const input = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  return input
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function readServiceAccount() {
  let raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

  if (!raw && process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
    raw = Buffer.from(
      process.env.FIREBASE_SERVICE_ACCOUNT_BASE64,
      "base64"
    ).toString("utf8");
  }

  if (!raw) {
    throw new Error(
      "Missing FIREBASE_SERVICE_ACCOUNT_JSON Netlify environment variable"
    );
  }

  const account = JSON.parse(raw);
  if (!account.client_email || !account.private_key || !account.project_id) {
    throw new Error("Firebase service-account JSON is incomplete");
  }
  account.private_key = account.private_key.replace(/\\n/g, "\n");
  return account;
}

async function getGoogleAccessToken(account) {
  const now = Math.floor(Date.now() / 1000);
  if (cachedGoogleToken && cachedGoogleTokenExpiresAt > now + 90) {
    return cachedGoogleToken;
  }

  const header = base64url(JSON.stringify({alg: "RS256", typ: "JWT"}));
  const claims = base64url(
    JSON.stringify({
      iss: account.client_email,
      scope: [
        "https://www.googleapis.com/auth/firebase.messaging",
        "https://www.googleapis.com/auth/datastore"
      ].join(" "),
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600
    })
  );
  const unsignedJwt = `${header}.${claims}`;
  const signature = crypto.sign(
    "RSA-SHA256",
    Buffer.from(unsignedJwt),
    account.private_key
  );
  const assertion = `${unsignedJwt}.${base64url(signature)}`;

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {"Content-Type": "application/x-www-form-urlencoded"},
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion
    })
  });

  const result = await response.json();
  if (!response.ok || !result.access_token) {
    throw new Error(result.error_description || "Could not authorize Firebase service account");
  }

  cachedGoogleToken = result.access_token;
  cachedGoogleTokenExpiresAt = now + Number(result.expires_in || 3600);
  return cachedGoogleToken;
}

async function verifySupabaseUser(authorization) {
  if (!authorization || !authorization.startsWith("Bearer ")) {
    throw Object.assign(new Error("Missing login token"), {statusCode: 401});
  }

  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: authorization
    }
  });

  if (!response.ok) {
    throw Object.assign(new Error("Invalid or expired login token"), {
      statusCode: 401
    });
  }

  const user = await response.json();
  if (!user?.id) {
    throw Object.assign(new Error("Could not verify the logged-in user"), {
      statusCode: 401
    });
  }
  return user;
}

function decodeFirestoreValue(value) {
  if (!value || typeof value !== "object") return null;
  if (Object.hasOwn(value, "stringValue")) return value.stringValue;
  if (Object.hasOwn(value, "booleanValue")) return value.booleanValue;
  if (Object.hasOwn(value, "integerValue")) return Number(value.integerValue);
  if (Object.hasOwn(value, "doubleValue")) return Number(value.doubleValue);
  if (Object.hasOwn(value, "nullValue")) return null;
  if (value.arrayValue) {
    return (value.arrayValue.values || []).map(decodeFirestoreValue);
  }
  if (value.mapValue) {
    return decodeFirestoreFields(value.mapValue.fields || {});
  }
  return null;
}

function decodeFirestoreFields(fields) {
  const output = {};
  for (const [key, value] of Object.entries(fields || {})) {
    output[key] = decodeFirestoreValue(value);
  }
  return output;
}

function firestoreBase(projectId) {
  return `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents`;
}

async function firestoreGetDocument(projectId, token, path) {
  const response = await fetch(`${firestoreBase(projectId)}/${path}`, {
    headers: {Authorization: `Bearer ${token}`}
  });

  if (response.status === 404) return null;
  const result = await response.json();
  if (!response.ok) {
    throw new Error(result.error?.message || "Could not read Firestore document");
  }
  return {name: result.name, data: decodeFirestoreFields(result.fields || {})};
}

async function firestoreListDevices(projectId, token, uid) {
  const devices = [];
  let pageToken = "";

  do {
    const url = new URL(
      `${firestoreBase(projectId)}/users/${encodeURIComponent(uid)}/devices`
    );
    url.searchParams.set("pageSize", "100");
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const response = await fetch(url, {
      headers: {Authorization: `Bearer ${token}`}
    });
    const result = await response.json();

    if (response.status === 404) return devices;
    if (!response.ok) {
      throw new Error(result.error?.message || "Could not read notification devices");
    }

    for (const document of result.documents || []) {
      devices.push({
        name: document.name,
        data: decodeFirestoreFields(document.fields || {})
      });
    }
    pageToken = result.nextPageToken || "";
  } while (pageToken && devices.length < 500);

  return devices.slice(0, 500);
}

async function firestoreDeleteDocument(token, documentName) {
  const response = await fetch(
    `https://firestore.googleapis.com/v1/${documentName}`,
    {
      method: "DELETE",
      headers: {Authorization: `Bearer ${token}`}
    }
  );
  if (!response.ok && response.status !== 404) {
    console.warn("Could not delete invalid FCM token document", response.status);
  }
}

async function collectRecipientTokens(projectId, googleToken, recipientUid) {
  const [userDoc, devices] = await Promise.all([
    firestoreGetDocument(
      projectId,
      googleToken,
      `users/${encodeURIComponent(recipientUid)}`
    ),
    firestoreListDevices(projectId, googleToken, recipientUid)
  ]);

  const entries = [];
  for (const device of devices) {
    if (
      device.data.enabled !== false &&
      typeof device.data.token === "string" &&
      device.data.token.trim()
    ) {
      entries.push({
        token: device.data.token.trim(),
        documentName: device.name
      });
    }
  }

  const legacyToken = userDoc?.data?.fcmToken;
  if (typeof legacyToken === "string" && legacyToken.trim()) {
    entries.push({token: legacyToken.trim(), documentName: null});
  }

  return entries;
}

function fcmErrorCode(result) {
  const details = result?.error?.details;
  if (!Array.isArray(details)) return "";
  const fcmDetail = details.find(item =>
    String(item?.["@type"] || "").includes("google.firebase.fcm.v1.FcmError")
  );
  return fcmDetail?.errorCode || "";
}

async function sendOneFcm(projectId, googleToken, entry, data) {
  const response = await fetch(
    `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/messages:send`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${googleToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        message: {
          token: entry.token,
          data,
          webpush: {
            headers: {
              Urgency: data.type === "call" ? "high" : "normal",
              TTL: data.type === "call" ? "60" : "86400"
            }
          }
        }
      })
    }
  );

  const result = await response.json().catch(() => ({}));
  return {
    ok: response.ok,
    status: response.status,
    errorCode: fcmErrorCode(result),
    result
  };
}

async function runInChunks(items, chunkSize, task) {
  const results = [];
  for (let index = 0; index < items.length; index += chunkSize) {
    const chunk = items.slice(index, index + chunkSize);
    results.push(...(await Promise.all(chunk.map(task))));
  }
  return results;
}

exports.handler = async function handler(event) {
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: {
        Allow: "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
        "Access-Control-Allow-Methods": "POST, OPTIONS"
      },
      body: ""
    };
  }

  if (event.httpMethod !== "POST") {
    return json(405, {error: "Use POST"});
  }

  try {
    const authenticatedUser = await verifySupabaseUser(
      event.headers.authorization || event.headers.Authorization
    );

    let input;
    try {
      input = JSON.parse(event.body || "{}");
    } catch {
      return json(400, {error: "Invalid JSON body"});
    }

    const type = cleanText(input.type, "message", 20).toLowerCase();
    if (!ALLOWED_TYPES.has(type)) {
      return json(400, {error: "Unsupported notification type"});
    }

    const recipients = Array.from(
      new Set(
        (Array.isArray(input.recipients) ? input.recipients : [input.to])
          .map(value => cleanText(value, "", 160))
          .filter(Boolean)
      )
    ).slice(0, 50);

    const chatId = cleanText(input.chatId, "", 220);
    if (!recipients.length || !chatId) {
      return json(400, {error: "Recipients and chatId are required"});
    }

    const account = readServiceAccount();
    const googleToken = await getGoogleAccessToken(account);
    const projectId = account.project_id;

    const [chatDoc, senderDoc] = await Promise.all([
      firestoreGetDocument(
        projectId,
        googleToken,
        `chats/${encodeURIComponent(chatId)}`
      ),
      firestoreGetDocument(
        projectId,
        googleToken,
        `users/${encodeURIComponent(authenticatedUser.id)}`
      )
    ]);

    if (!chatDoc) {
      return json(404, {error: "Chat not found"});
    }

    const chatMembers = Array.isArray(chatDoc.data.members)
      ? chatDoc.data.members
      : [];
    const senderUid = authenticatedUser.id;

    if (
      !chatMembers.includes(senderUid) ||
      recipients.some(uid => uid === senderUid || !chatMembers.includes(uid))
    ) {
      return json(403, {
        error: "Notification recipients are not valid chat members"
      });
    }

    const senderName = cleanText(
      senderDoc?.data?.name,
      authenticatedUser.email?.split("@")[0] || "MOODCHAT",
      80
    );
    const callKind = input.callKind === "video" ? "video" : "audio";
    const notificationBody =
      type === "call"
        ? `Incoming ${callKind} call`
        : cleanText(input.body, "You have a new message", 180);

    const requestedUrl = cleanText(
      input.url,
      `/?chat=${encodeURIComponent(chatId)}`,
      500
    );
    const url = requestedUrl.startsWith("/")
      ? requestedUrl
      : `/?chat=${encodeURIComponent(chatId)}`;

    const tokenEntries = (
      await Promise.all(
        recipients.map(uid =>
          collectRecipientTokens(projectId, googleToken, uid)
        )
      )
    ).flat();

    const uniqueEntries = [];
    const seenTokens = new Set();
    for (const entry of tokenEntries) {
      if (!seenTokens.has(entry.token)) {
        seenTokens.add(entry.token);
        uniqueEntries.push(entry);
      }
    }

    if (!uniqueEntries.length) {
      return json(200, {
        ok: true,
        state: "no-token",
        successCount: 0,
        failureCount: 0
      });
    }

    const pushData = {
      title: senderName,
      body: notificationBody,
      type,
      chatId,
      from: senderUid,
      url
    };

    const results = await runInChunks(uniqueEntries, 20, entry =>
      sendOneFcm(projectId, googleToken, entry, pushData)
    );

    let successCount = 0;
    let failureCount = 0;
    const cleanup = [];

    results.forEach((result, index) => {
      if (result.ok) {
        successCount += 1;
      } else {
        failureCount += 1;
        if (
          result.errorCode === "UNREGISTERED" &&
          uniqueEntries[index]?.documentName
        ) {
          cleanup.push(
            firestoreDeleteDocument(
              googleToken,
              uniqueEntries[index].documentName
            )
          );
        }
      }
    });

    await Promise.allSettled(cleanup);

    return json(200, {
      ok: true,
      state: successCount > 0 ? "sent" : "failed",
      successCount,
      failureCount
    });
  } catch (error) {
    console.error("MOODCHAT notification function failed", error);
    return json(error.statusCode || 500, {
      error:
        error.statusCode && error.statusCode < 500
          ? error.message
          : "Notification service is not configured or temporarily unavailable"
    });
  }
};
