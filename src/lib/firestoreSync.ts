import { User } from 'firebase/auth';
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  limit,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
  where,
  writeBatch,
} from 'firebase/firestore';
import {
  BLUEPRINT_LIMITS,
  clampText,
  db,
  handleFirestoreError,
  OperationType,
  sanitizeBlueprintId,
} from './firebase';

export interface CloudCatalogSnapshot {
  id: string;
  ownerUid: string;
  workspaceId: string;
  title: string;
  totalProducts: number;
  totalLocations: number;
  totalPhysicalStock: number;
  summaryNotes: string;
  createdAtMs: number;
}

export interface CloudCatalogItem {
  id: string;
  ownerUid: string;
  workspaceId: string;
  sku: string;
  description: string;
  family: string;
  brand: string;
  unitOfMeasure: string;
  totalErpPhysical: number;
  totalCommitted: number;
  totalAvailable: number;
  criticalityLevel: 'ALTA' | 'MEDIA' | 'BAJA';
  updatedAtMs: number;
}

export interface CloudCountRecord {
  id: string;
  ownerUid: string;
  workspaceId: string;
  countNumber: string;
  locationName: string;
  scheduledDate: string;
  status: string;
  itemsCount: number;
  discrepanciesCount: number;
  counterName: string;
  updatedAtMs: number;
}

function toMillis(val: unknown): number {
  if (val instanceof Timestamp) return val.toMillis();
  if (val && typeof val === 'object' && 'toMillis' in val && typeof (val as { toMillis: () => number }).toMillis === 'function') {
    return (val as { toMillis: () => number }).toMillis();
  }
  return Date.now();
}

export function getWorkspaceIdForUser(uid: string): string {
  return sanitizeBlueprintId(`ws_${uid}`, 'ws_default');
}

export async function ensureFirebaseWorkspace(user: User): Promise<string> {
  const uid = sanitizeBlueprintId(user.uid, 'user');
  const displayName = clampText(
    user.displayName || user.email?.split('@')[0] || 'Usuario MercoMat',
    BLUEPRINT_LIMITS.DISPLAY_NAME_MAX,
    'Usuario MercoMat'
  );
  const userPath = `users/${uid}`;
  const userRef = doc(db, 'users', uid);

  try {
    const userSnap = await getDoc(userRef);
    if (!userSnap.exists()) {
      const assignedRole =
        user.email === 'mor.edu89@gmail.com' && user.emailVerified ? 'JEFE_STOCK' : 'CONTADOR';
      await setDoc(userRef, {
        uid,
        displayName,
        role: assignedRole,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } else {
      await updateDoc(userRef, {
        displayName,
        updatedAt: serverTimestamp(),
      });
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, userPath);
  }

  if (user.email) {
    const privatePath = `users/${uid}/private/profile`;
    const privateRef = doc(db, 'users', uid, 'private', 'profile');
    try {
      const privSnap = await getDoc(privateRef);
      const cleanEmail = clampText(user.email, BLUEPRINT_LIMITS.EMAIL_MAX, 'usuario@mercomat.local');
      if (!privSnap.exists()) {
        await setDoc(privateRef, {
          uid,
          email: cleanEmail,
          updatedAt: serverTimestamp(),
        });
      } else {
        await updateDoc(privateRef, {
          email: cleanEmail,
          updatedAt: serverTimestamp(),
        });
      }
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, privatePath);
    }
  }

  const workspaceId = getWorkspaceIdForUser(uid);
  const wsPath = `workspaces/${workspaceId}`;
  const wsRef = doc(db, 'workspaces', workspaceId);
  try {
    const wsSnap = await getDoc(wsRef);
    if (!wsSnap.exists()) {
      await setDoc(wsRef, {
        id: workspaceId,
        ownerUid: uid,
        name: clampText('MercoMat — Casa Central y Sucursales', BLUEPRINT_LIMITS.WORKSPACE_NAME_MAX, 'MercoMat'),
        projectCode: 'MERCOMAT_ERP',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, wsPath);
  }

  return workspaceId;
}

export function subscribeCloudSnapshots(
  workspaceId: string,
  ownerUid: string,
  onData: (rows: CloudCatalogSnapshot[]) => void,
  onError: (err: Error) => void
): () => void {
  const path = `workspaces/${workspaceId}/catalogSnapshots`;
  const q = query(
    collection(db, 'workspaces', workspaceId, 'catalogSnapshots'),
    where('ownerUid', '==', ownerUid),
    limit(25)
  );
  return onSnapshot(
    q,
    (snapshot) => {
      const items: CloudCatalogSnapshot[] = snapshot.docs.map((d) => {
        const data = d.data();
        return {
          id: d.id,
          ownerUid: String(data.ownerUid || ''),
          workspaceId: String(data.workspaceId || workspaceId),
          title: String(data.title || ''),
          totalProducts: Number(data.totalProducts || 0),
          totalLocations: Number(data.totalLocations || 0),
          totalPhysicalStock: Number(data.totalPhysicalStock || 0),
          summaryNotes: String(data.summaryNotes || ''),
          createdAtMs: toMillis(data.createdAt),
        };
      });
      items.sort((a, b) => b.createdAtMs - a.createdAtMs);
      onData(items);
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.LIST, path);
      } catch (wrapped) {
        onError(wrapped as Error);
      }
    }
  );
}

export function subscribeCloudCatalogItems(
  workspaceId: string,
  ownerUid: string,
  onData: (rows: CloudCatalogItem[]) => void,
  onError: (err: Error) => void
): () => void {
  const path = `workspaces/${workspaceId}/catalogItems`;
  const q = query(
    collection(db, 'workspaces', workspaceId, 'catalogItems'),
    where('ownerUid', '==', ownerUid),
    limit(150)
  );
  return onSnapshot(
    q,
    (snapshot) => {
      const items: CloudCatalogItem[] = snapshot.docs.map((d) => {
        const data = d.data();
        return {
          id: d.id,
          ownerUid: String(data.ownerUid || ''),
          workspaceId: String(data.workspaceId || workspaceId),
          sku: String(data.sku || ''),
          description: String(data.description || ''),
          family: String(data.family || 'General'),
          brand: String(data.brand || 'Sin marca'),
          unitOfMeasure: String(data.unitOfMeasure || 'UN'),
          totalErpPhysical: Number(data.totalErpPhysical || 0),
          totalCommitted: Number(data.totalCommitted || 0),
          totalAvailable: Number(data.totalAvailable || 0),
          criticalityLevel:
            data.criticalityLevel === 'ALTA' || data.criticalityLevel === 'BAJA'
              ? data.criticalityLevel
              : 'MEDIA',
          updatedAtMs: toMillis(data.updatedAt),
        };
      });
      items.sort((a, b) => a.sku.localeCompare(b.sku));
      onData(items);
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.LIST, path);
      } catch (wrapped) {
        onError(wrapped as Error);
      }
    }
  );
}

export function subscribeCloudCountRecords(
  workspaceId: string,
  ownerUid: string,
  onData: (rows: CloudCountRecord[]) => void,
  onError: (err: Error) => void
): () => void {
  const path = `workspaces/${workspaceId}/countRecords`;
  const q = query(
    collection(db, 'workspaces', workspaceId, 'countRecords'),
    where('ownerUid', '==', ownerUid),
    limit(100)
  );
  return onSnapshot(
    q,
    (snapshot) => {
      const items: CloudCountRecord[] = snapshot.docs.map((d) => {
        const data = d.data();
        return {
          id: d.id,
          ownerUid: String(data.ownerUid || ''),
          workspaceId: String(data.workspaceId || workspaceId),
          countNumber: String(data.countNumber || ''),
          locationName: String(data.locationName || ''),
          scheduledDate: String(data.scheduledDate || ''),
          status: String(data.status || 'EJECUCION'),
          itemsCount: Number(data.itemsCount || 0),
          discrepanciesCount: Number(data.discrepanciesCount || 0),
          counterName: String(data.counterName || ''),
          updatedAtMs: toMillis(data.updatedAt),
        };
      });
      items.sort((a, b) => b.updatedAtMs - a.updatedAtMs);
      onData(items);
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.LIST, path);
      } catch (wrapped) {
        onError(wrapped as Error);
      }
    }
  );
}

export async function syncInventoryAndCountsToCloud(params: {
  user: User;
  title: string;
  summaryNotes: string;
  totalLocations: number;
  consolidatedProducts: Array<Record<string, unknown>>;
  counts: Array<Record<string, unknown>>;
}): Promise<{ snapshotId: string; syncedProducts: number; syncedCounts: number }> {
  const workspaceId = await ensureFirebaseWorkspace(params.user);
  const ownerUid = sanitizeBlueprintId(params.user.uid, 'user');

  const snapshotId = sanitizeBlueprintId(`snap_${Date.now()}`, 'snap_latest');
  const totalPhysicalStock = params.consolidatedProducts.reduce(
    (sum, item) => sum + Math.max(0, Number(item.total_erp_physical || 0)),
    0
  );

  const snapshotPath = `workspaces/${workspaceId}/catalogSnapshots/${snapshotId}`;
  try {
    await setDoc(doc(db, 'workspaces', workspaceId, 'catalogSnapshots', snapshotId), {
      ownerUid,
      workspaceId,
      title: clampText(params.title, BLUEPRINT_LIMITS.SNAPSHOT_TITLE_MAX, 'Respaldo MercoMat'),
      totalProducts: Math.max(0, Math.trunc(params.consolidatedProducts.length)),
      totalLocations: Math.max(0, Math.trunc(params.totalLocations)),
      totalPhysicalStock: Math.max(0, Number(totalPhysicalStock.toFixed(2))),
      summaryNotes: clampText(params.summaryNotes, BLUEPRINT_LIMITS.SNAPSHOT_NOTES_MAX, ''),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, snapshotPath);
  }

  // Sync up to 100 master catalog items in Firestore batches (only create/update)
  const itemsSlice = params.consolidatedProducts.slice(0, 100);
  if (itemsSlice.length > 0) {
    const batch = writeBatch(db);
    for (const row of itemsSlice) {
      const sku = clampText(String(row.sku || ''), BLUEPRINT_LIMITS.SKU_MAX, 'SKU');
      const itemId = sanitizeBlueprintId(`sku_${sku}`, 'sku_item');
      const itemRef = doc(db, 'workspaces', workspaceId, 'catalogItems', itemId);
      const existingItem = await getDoc(itemRef).catch((err) =>
        handleFirestoreError(err, OperationType.GET, `workspaces/${workspaceId}/catalogItems/${itemId}`)
      );

      const critRaw = String(row.criticality_level || 'MEDIA').toUpperCase();
      const criticalityLevel =
        critRaw === 'ALTA' || critRaw === 'BAJA' ? critRaw : 'MEDIA';

      if (existingItem.exists()) {
        batch.update(itemRef, {
          sku,
          description: clampText(
            String(row.description || sku),
            BLUEPRINT_LIMITS.DESCRIPTION_MAX,
            sku
          ),
          family: clampText(String(row.family || 'General'), BLUEPRINT_LIMITS.FAMILY_MAX, 'General'),
          brand: clampText(String(row.brand || 'Sin marca'), BLUEPRINT_LIMITS.BRAND_MAX, 'Sin marca'),
          unitOfMeasure: clampText(
            String(row.unit_of_measure || 'UN'),
            BLUEPRINT_LIMITS.UOM_MAX,
            'UN'
          ),
          totalErpPhysical: Math.max(0, Number(row.total_erp_physical || 0)),
          totalCommitted: Math.max(0, Number(row.total_committed || 0)),
          totalAvailable: Math.max(0, Number(row.total_available || 0)),
          criticalityLevel,
          updatedAt: serverTimestamp(),
        });
      } else {
        batch.set(itemRef, {
          ownerUid,
          workspaceId,
          sku,
          description: clampText(
            String(row.description || sku),
            BLUEPRINT_LIMITS.DESCRIPTION_MAX,
            sku
          ),
          family: clampText(String(row.family || 'General'), BLUEPRINT_LIMITS.FAMILY_MAX, 'General'),
          brand: clampText(String(row.brand || 'Sin marca'), BLUEPRINT_LIMITS.BRAND_MAX, 'Sin marca'),
          unitOfMeasure: clampText(
            String(row.unit_of_measure || 'UN'),
            BLUEPRINT_LIMITS.UOM_MAX,
            'UN'
          ),
          totalErpPhysical: Math.max(0, Number(row.total_erp_physical || 0)),
          totalCommitted: Math.max(0, Number(row.total_committed || 0)),
          totalAvailable: Math.max(0, Number(row.total_available || 0)),
          criticalityLevel,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }
    }

    try {
      await batch.commit();
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `workspaces/${workspaceId}/catalogItems`);
    }
  }

  // Sync up to 50 count records
  const countsSlice = params.counts.slice(0, 50);
  if (countsSlice.length > 0) {
    const batch = writeBatch(db);
    for (const c of countsSlice) {
      const countNumber = clampText(
        String(c.count_number || `CNT_${c.id || '0'}`),
        BLUEPRINT_LIMITS.COUNT_NUMBER_MAX,
        'CNT'
      );
      const recordId = sanitizeBlueprintId(`cnt_${countNumber}`, 'cnt_item');
      const recRef = doc(db, 'workspaces', workspaceId, 'countRecords', recordId);
      const existingRec = await getDoc(recRef).catch((err) =>
        handleFirestoreError(err, OperationType.GET, `workspaces/${workspaceId}/countRecords/${recordId}`)
      );

      const allowedStatuses = new Set([
        'EJECUCION',
        'ENTREGADO',
        'APROBADO',
        'RECHAZADO',
      ]);
      const rawStatus = String(c.status || '');
      const status = allowedStatuses.has(rawStatus)
        ? rawStatus
        : 'EJECUCION';

      const payloadFields = {
        countNumber,
        locationName: clampText(
          String(c.location_name || 'Casa Central'),
          BLUEPRINT_LIMITS.LOCATION_NAME_MAX,
          'Casa Central'
        ),
        scheduledDate: clampText(
          String(c.scheduled_date || new Date().toISOString().slice(0, 10)),
          BLUEPRINT_LIMITS.DATE_MAX,
          '2026-01-01'
        ),
        status,
        itemsCount: Math.max(0, Math.trunc(Number(c.items_count || 0))),
        discrepanciesCount: Math.max(0, Math.trunc(Number(c.discrepancies_count || 0))),
        counterName: clampText(
          String(c.counter_name || 'Responsable Asignado'),
          BLUEPRINT_LIMITS.COUNTER_NAME_MAX,
          'Responsable Asignado'
        ),
        updatedAt: serverTimestamp(),
      };

      if (existingRec.exists()) {
        // Respect terminal state lock if already APROBADO on non-admin client
        if (String(existingRec.data().status || '') !== 'APROBADO') {
          batch.update(recRef, payloadFields);
        }
      } else {
        batch.set(recRef, {
          ownerUid,
          workspaceId,
          ...payloadFields,
          createdAt: serverTimestamp(),
        });
      }
    }

    try {
      await batch.commit();
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `workspaces/${workspaceId}/countRecords`);
    }
  }

  return {
    snapshotId,
    syncedProducts: itemsSlice.length,
    syncedCounts: countsSlice.length,
  };
}

export async function deleteCloudSnapshot(workspaceId: string, snapshotId: string): Promise<void> {
  const path = `workspaces/${workspaceId}/catalogSnapshots/${snapshotId}`;
  try {
    await deleteDoc(doc(db, 'workspaces', workspaceId, 'catalogSnapshots', snapshotId));
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, path);
  }
}
