import { writeWidgetData } from '../../modules/widget-bridge'
import { buildWidgetPayload } from './payload'

/**
 * Push today's numbers to the home screen widget. Only ever called with
 * TODAY's totals — a look back at last Tuesday must not repaint the widget.
 * A no-op on builds without the widget.
 */
export function updateWidget(
  date: string,
  totals: { kcal: number; protein_g: number; carbs_g: number; fat_g: number; mealCount: number },
  goal: { targetKcal: number; protein_g: number; carbs_g: number; fat_g: number },
): boolean {
  return writeWidgetData(JSON.stringify(buildWidgetPayload(date, totals, goal)))
}
