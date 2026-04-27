const SR_LOCALE = 'sr';
const COLLATOR_OPTIONS = { sensitivity: 'base' };

function clean(value) {
  return String(value || '').trim();
}

export function employeeFirstName(emp) {
  return clean(emp?.firstName ?? emp?.first_name ?? emp?.employeeFirstName ?? emp?.employee_first_name);
}

export function employeeLastName(emp) {
  return clean(emp?.lastName ?? emp?.last_name ?? emp?.employeeLastName ?? emp?.employee_last_name);
}

export function employeeRawName(emp) {
  return clean(emp?.fullName ?? emp?.full_name ?? emp?.employeeName ?? emp?.name);
}

export function employeeDisplayName(emp) {
  const first = employeeFirstName(emp);
  const last = employeeLastName(emp);
  if (last || first) return [last, first].filter(Boolean).join(' ');
  return employeeRawName(emp);
}

function fallbackSurname(emp) {
  const last = employeeLastName(emp);
  if (last) return last;
  const parts = employeeDisplayName(emp).split(/\s+/).filter(Boolean);
  return parts[0] || '';
}

export function compareEmployeesByLastFirst(a, b) {
  const last = fallbackSurname(a).localeCompare(fallbackSurname(b), SR_LOCALE, COLLATOR_OPTIONS);
  if (last !== 0) return last;

  const first = employeeFirstName(a).localeCompare(employeeFirstName(b), SR_LOCALE, COLLATOR_OPTIONS);
  if (first !== 0) return first;

  return employeeDisplayName(a).localeCompare(employeeDisplayName(b), SR_LOCALE, COLLATOR_OPTIONS);
}
