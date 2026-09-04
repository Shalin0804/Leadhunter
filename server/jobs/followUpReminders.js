const { Op } = require('sequelize');
const { Task } = require('../models');

/**
 * Example job (not scheduled in Phase 1).
 * Finds overdue, still-open follow-up tasks so a future notifier can act on them.
 */
module.exports = {
  name: 'follow-up-reminders',
  schedule: '0 8 * * *', // 08:00 daily — interpreted by the Phase 2 scheduler

  async run() {
    const overdue = await Task.findAll({
      where: {
        is_follow_up: true,
        status: { [Op.notIn]: ['COMPLETED', 'CANCELLED'] },
        due_date: { [Op.lt]: new Date() },
      },
      order: [['due_date', 'ASC']],
    });

    // Phase 2: dispatch digest emails / notifications here.
    return { overdueCount: overdue.length, taskIds: overdue.map((t) => t.id) };
  },
};
