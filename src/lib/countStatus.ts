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
  CountStatus.BORRADOR,
  CountStatus.ASIGNADO,
  CountStatus.EN_EJECUCION,
  CountStatus.PENDIENTE_APROBACION,
  CountStatus.RECHAZADO,
  CountStatus.APROBADO,
  CountStatus.PENDIENTE_REGULARIZACION,
  CountStatus.CERRADO,
];

export const COUNT_STATUS_META: Record<CountStatus, CountStatusVisualMeta> = {
  [CountStatus.BORRADOR]: {
    status: CountStatus.BORRADOR,
    label: 'Borrador',
    shortLabel: 'Borrador',
    step: 1,
    description: 'Conteo creado, pendiente de asignación a un responsable.',
    textClass: 'text-slate-700',
    surfaceClass: 'bg-slate-100 border-slate-300',
    dotClass: 'bg-slate-400',
  },
  [CountStatus.ASIGNADO]: {
    status: CountStatus.ASIGNADO,
    label: 'Asignado',
    shortLabel: 'Asignado',
    step: 2,
    description: 'Responsable designado y tarea disponible para iniciar.',
    textClass: 'text-sky-800',
    surfaceClass: 'bg-sky-50 border-sky-200',
    dotClass: 'bg-sky-600',
  },
  [CountStatus.EN_EJECUCION]: {
    status: CountStatus.EN_EJECUCION,
    label: 'En Ejecución',
    shortLabel: 'En Ejecución',
    step: 3,
    description: 'El contador inició el relevamiento físico.',
    textClass: 'text-indigo-800',
    surfaceClass: 'bg-indigo-50 border-indigo-200',
    dotClass: 'bg-indigo-600',
  },
  [CountStatus.PENDIENTE_APROBACION]: {
    status: CountStatus.PENDIENTE_APROBACION,
    label: 'Pendiente de Aprobación',
    shortLabel: 'Pend. Aprobación',
    step: 4,
    description: 'Resultados presentados esperando revisión del Jefe de Control de Stock.',
    textClass: 'text-amber-800',
    surfaceClass: 'bg-amber-50 border-amber-200',
    dotClass: 'bg-amber-600',
  },
  [CountStatus.RECHAZADO]: {
    status: CountStatus.RECHAZADO,
    label: 'Rechazado',
    shortLabel: 'Rechazado',
    step: 5,
    description: 'Devuelto al contador con observaciones o solicitud de corrección.',
    textClass: 'text-red-800',
    surfaceClass: 'bg-red-50 border-red-200',
    dotClass: 'bg-red-600',
  },
  [CountStatus.APROBADO]: {
    status: CountStatus.APROBADO,
    label: 'Aprobado',
    shortLabel: 'Aprobado',
    step: 6,
    description: 'Resultado físico validado por el Jefe sin alterar aún el stock ERP.',
    textClass: 'text-teal-800',
    surfaceClass: 'bg-teal-50 border-teal-200',
    dotClass: 'bg-teal-600',
  },
  [CountStatus.PENDIENTE_REGULARIZACION]: {
    status: CountStatus.PENDIENTE_REGULARIZACION,
    label: 'Pendiente de Regularización',
    shortLabel: 'Pend. Regulariz.',
    step: 7,
    description: 'Aprobado; requiere documentar ajuste ERP, movimiento o justificación.',
    textClass: 'text-orange-800',
    surfaceClass: 'bg-orange-50 border-orange-200',
    dotClass: 'bg-orange-600',
  },
  [CountStatus.CERRADO]: {
    status: CountStatus.CERRADO,
    label: 'Cerrado / Finalizado',
    shortLabel: 'Cerrado',
    step: 8,
    description: 'Proceso terminado, conciliado y bloqueado permanentemente.',
    textClass: 'text-emerald-800',
    surfaceClass: 'bg-emerald-50 border-emerald-200',
    dotClass: 'bg-emerald-600',
  },
};

export function getCountStatusMeta(status: string | undefined | null): CountStatusVisualMeta {
  if (status && status in COUNT_STATUS_META) {
    return COUNT_STATUS_META[status as CountStatus];
  }
  return COUNT_STATUS_META[CountStatus.BORRADOR];
}
