export type AppErrorCode = 'E_SELECTOR' | 'E_NO_PAGE' | 'E_WAIT_TIMEOUT' | 'E_FS' | 'E_INTERNAL'

export type LaunchErrorCode = 'E_SPAWN' | 'E_EXIT_EARLY' | 'E_CDP_TIMEOUT'

/**
 * Union of all error codes produced by the library, useful for branching on `code`.
 */
export type ErrorCode = AppErrorCode | LaunchErrorCode
