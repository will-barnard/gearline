package com.gearline.domain.sync;

public enum SyncJobStatus {
    QUEUED,
    IN_PROGRESS,
    COMPLETED,
    FAILED,
    DEAD_LETTERED,
    CANCELLED
}
