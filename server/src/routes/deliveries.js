import { Hono } from 'hono';
import { notFound } from '../errors.js';

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

  return app;
}
export default deliveryRoutes;
