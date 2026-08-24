import { Hono } from 'hono';
import { AppError, notFound } from '../errors.js';

/** POST /v1/deliveries/:id/ack — state → downloaded. */
export function deliveryRoutes(ctx) {
  const app = new Hono();
  const { db, events } = ctx;

  app.post('/:id/ack', (c) => {
    const id = c.req.param('id');
    const existing = db.getDelivery(id);
    if (!existing) throw notFound(`no delivery ${id}`);

    const updated = db.ackDelivery(id);
    db.touchDevice(updated.device_id);

    const transfer = db.getTransfer(updated.transfer_id);
    const audience = db.deviceIdsForTransfer(updated.transfer_id);
    if (transfer?.from_device_id) audience.push(transfer.from_device_id);

    events.publish(
      'delivery.acked',
      {
        transfer_id: updated.transfer_id,
        delivery_id: updated.id,
        device_id: updated.device_id,
      },
      { audience },
    );

    return c.json({ ok: true });
  });

  /**
   * POST /v1/deliveries/:id/decline — state → declined.
   *
   * The recipient says "not this one". The bytes are NOT deleted: other
   * recipients may still want them, and the sender's own copy is not the
   * recipient's to destroy. What changes is that this delivery stops being
   * pending, so the sender sees a real answer instead of a notification that
   * silently went nowhere, and the recipient's clients can stop offering it.
   *
   * Idempotent: declining twice is fine, and only the call that changed the
   * row announces. A delivery already downloaded cannot be declined — you
   * cannot un-receive something.
   */
  app.post('/:id/decline', (c) => {
    const id = c.req.param('id');
    const existing = db.getDelivery(id);
    if (!existing) throw notFound(`no delivery ${id}`);

    if (existing.state === 'downloaded') {
      throw new AppError('bad_request', 'this delivery was already downloaded');
    }

    const { delivery, changed } = db.declineDelivery(id);
    db.touchDevice(delivery.device_id);

    if (changed) {
      const transfer = db.getTransfer(delivery.transfer_id);
      const audience = db.deviceIdsForTransfer(delivery.transfer_id);
      if (transfer?.from_device_id) audience.push(transfer.from_device_id);

      events.publish(
        'delivery.declined',
        {
          transfer_id: delivery.transfer_id,
          delivery_id: delivery.id,
          device_id: delivery.device_id,
        },
        { audience },
      );
    }

    return c.json({ ok: true, state: delivery.state });
  });

  return app;
}
export default deliveryRoutes;
