/** Keep feedback visible after navigation, while limiting modal effects to the originating form. */
export async function reportRoleDelivery(
  delivery: Promise<boolean>,
  isActive: () => boolean,
  report: (sent: boolean, active: boolean) => void,
  close: () => void,
): Promise<void> {
  const sent = await delivery.catch(() => false);
  const active = isActive();
  report(sent, active);
  if (sent && active) close();
}
