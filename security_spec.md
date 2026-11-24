# Security Specification — MercoMat Cloud Firestore Persistence

## 1. Data Invariants
1. **Default-Deny Root**: Every unmatched document path under `/databases/{database}/documents` is rejected for both reads and writes.
2. **Identity & Email Verification**: All user-initiated writes require an authenticated user (`request.auth != null`) with a verified email (`request.auth.token.email_verified == true`), preventing spoofed unverified email attacks.
3. **Self-Assigned Role Prevention**: Regular users cannot assign themselves privileged roles (`JEFE_STOCK`, `RESPONSABLE_DEPOSITO`) during profile creation or escalate their `role` on profile updates; only trusted admins (`/admins/{uid}` or verified bootstrap admin `mor.edu89@gmail.com`) may modify roles.
4. **PII Isolation**: User email addresses are stored exclusively inside `/users/{userId}/private/{docId}`, readable and writable only by the owning user or an admin.
5. **Master Gate Ownership**: All subcollection records (`catalogSnapshots`, `catalogItems`, `countRecords`) under `/workspaces/{workspaceId}` require parent workspace existence and ownership verification (`get(.../workspaces/{workspaceId}).data.ownerUid == request.auth.uid`) on create/update, and store `ownerUid` on each document so `allow list` enforces ownership directly on `resource.data` without `get()` lookups.
6. **Immutability & Temporal Integrity**: `uid`, `ownerUid`, `workspaceId`, and `createdAt` cannot be modified after creation, and `createdAt`/`updatedAt` must match `request.time`.
7. **Terminal State Locking**: Once a `CountRecord` reaches `status == 'CERRADO'`, non-admin updates are strictly rejected.

## 2. The "Dirty Dozen" Payloads (Expected: `PERMISSION_DENIED`)
1. **Unauthenticated Workspace Read**: `get(/workspaces/ws_1)` without auth -> `PERMISSION_DENIED`.
2. **Shadow Field Injection on User Create**: `create /users/u1` with `{ uid: "u1", displayName: "Test", role: "CONTADOR", isVerified: true, createdAt: serverTimestamp, updatedAt: serverTimestamp }` -> `PERMISSION_DENIED` (`hasOnly` check rejects `isVerified`).
3. **Privilege Escalation on User Create**: `create /users/u1` as non-admin with `role: "JEFE_STOCK"` -> `PERMISSION_DENIED`.
4. **Role Mutation on User Update**: `update /users/u1` as owner changing `role` from `"CONTADOR"` to `"JEFE_STOCK"` -> `PERMISSION_DENIED` (`affectedKeys().hasOnly(['displayName', 'updatedAt'])`).
5. **Email Spoof Attack (Unverified Email)**: User with `token.email == 'mor.edu89@gmail.com'` and `token.email_verified == false` writing `/admins/u_evil` -> `PERMISSION_DENIED`.
6. **Cross-User PII Read**: Authenticated user `u2` reading `/users/u1/private/email` -> `PERMISSION_DENIED`.
7. **Blanket Collection Scrape**: Authenticated user `u2` running `list /workspaces` without filtering to `ownerUid == u2` -> `PERMISSION_DENIED`.
8. **Orphaned Subcollection Write**: Authenticated user `u1` creating `/workspaces/nonexistent_ws/catalogItems/item1` -> `PERMISSION_DENIED` (`isWorkspaceOwner` `exists()` check fails).
9. **Resource Poisoning via Oversized ID**: Creating `/workspaces/${'a'.repeat(200)}` or non-matching chars `/workspaces/bad$id` -> `PERMISSION_DENIED` (`isValidId` fails).
10. **Client-Forged Timestamp**: Creating `/workspaces/ws_1` with client-supplied past `createdAt` instead of `request.time` -> `PERMISSION_DENIED`.
11. **Value Type Poisoning on Update**: Updating `/workspaces/ws_1/catalogItems/item1` with `totalErpPhysical: -50` or `description: "x".repeat(500)` -> `PERMISSION_DENIED` (`isValidCatalogItem` blocks invalid range/length).
12. **Terminal State Mutation**: Non-admin updating `/workspaces/ws_1/countRecords/cnt1` when `existing().status == 'CERRADO'` -> `PERMISSION_DENIED`.
