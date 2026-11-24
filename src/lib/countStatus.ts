import { CountStatus } from '../types/erp';

export interface CountStatusVisualMeta {
  status: CountStatus;
  label: string;
  shortLabel: string;
  step: number;
  description: string;
  textClass: string;
  surfaceClass: string;
  dotClass: string;
}

export const COUNT_STATUS_LIST: CountStatus[] = [
  CountStatus.EJECUCION,
  CountStatus.ENTREGADO,
  CountStatus.APROBADO,
  CountStatus.RECHAZADO,
];

export const COUNT_STATUS_META: Record<CountStatus, CountStatusVisualMeta> = {
  [CountStatus.EJECUCION]: {
    status: CountStatus.EJECUCION,
    label: 'En Ejecución',
    shortLabel: 'Ejecución',
    step: 1,
    description:
      'Estado inicial del conteo. Permite descargar planilla Excel, cargar/corregir resultados, guardar avances y presentar.',
    textClass: 'text-indigo-800',
    surfaceClass: 'bg-indigo-50 border-indigo-200',
    dotClass: 'bg-indigo-600',
  },
  [CountStatus.ENTREGADO]: {
    status: CountStatus.ENTREGADO,
    label: 'Entregado',
    shortLabel: 'Entregado',
    step: 2,
    description:
      'Versión presentada y bloqueada para el contador; queda pendiente de revisión por el Jefe de Control de Stock.',
    textClass: 'text-amber-800',
    surfaceClass: 'bg-amber-50 border-amber-200',
    dotClass: 'bg-amber-600',
  },
  [CountStatus.APROBADO]: {
    status: CountStatus.APROBADO,
    label: 'Aprobado',
    shortLabel: 'Aprobado',
    step: 3,
    description:
      'Resultado validado por el Jefe de Stock; bloquea modificaciones ordinarias y habilita seguimiento de diferencias y regularización ERP.',
    textClass: 'text-emerald-800',
    surfaceClass: 'bg-emerald-50 border-emerald-200',
    dotClass: 'bg-emerald-600',
  },
  [CountStatus.RECHAZADO]: {
    status: CountStatus.RECHAZADO,
    label: 'Rechazado',
    shortLabel: 'Rechazado',
    step: 4,
    description:
      'Devuelto con motivo obligatorio conservando la presentación anterior. Debe pasarse a Ejecución para corregir.',
    textClass: 'text-red-800',
    surfaceClass: 'bg-red-50 border-red-200',
    dotClass: 'bg-red-600',
  },
};

export function getCountStatusMeta(status: string | undefined | null): CountStatusVisualMeta {
  if (status && status in COUNT_STATUS_META) {
    return COUNT_STATUS_META[status as CountStatus];
  }
  return COUNT_STATUS_META[CountStatus.EJECUCION];
}
