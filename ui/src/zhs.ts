// Shared helpers for the Zhihuishu (知到) views. Mirrors the core model helpers
// in `src/zhihuishu/models.rs` so the UI counts match the backend plan exactly.
import type {
  ZhsCourse,
  ZhsCourseDetail,
  ZhsLesson,
  ZhsVideo,
  ZhsWatchState,
} from "./types";

/** Shortest human-readable course label. */
export function zhsCourseLabel(course: ZhsCourse): string {
  const name = course.name.trim();
  return name || `课程 ${course.courseId}（recruit ${course.recruitId}）`;
}

/** All videos of a lesson; lessons without small lessons expose their own id. */
export function zhsLessonVideos(lesson: ZhsLesson): ZhsVideo[] {
  if (lesson.videos.length > 0) return lesson.videos;
  if (lesson.videoId !== null && lesson.videoSec !== null) {
    return [
      {
        videoId: lesson.videoId,
        lessonVideoId: lesson.lessonId,
        videoSec: lesson.videoSec,
        isStudied: lesson.isStudied,
        name: lesson.name,
      },
    ];
  }
  return [];
}

/** Number of videos in the tree derived from the chapter payload. */
function countVideos(detail: ZhsCourseDetail): number {
  return detail.chapters.reduce(
    (total, chapter) =>
      total +
      chapter.lessons.reduce(
        (sum, lesson) => sum + zhsLessonVideos(lesson).length,
        0,
      ),
    0,
  );
}

/**
 * Total number of playable videos in a course tree.
 *
 * Prefers the backend count (computed from the corrected tree) and falls back
 * to a local walk when talking to an older backend.
 */
export function zhsTotalVideos(detail: ZhsCourseDetail): number {
  return typeof detail.totalVideos === "number"
    ? detail.totalVideos
    : countVideos(detail);
}

/**
 * Number of videos the platform records as finished (`watchState == 1`).
 *
 * The backend computes this from a fresh `queryStuyInfo` read; deriving it from
 * `video.isStudied` alone can show `0 / N` after a watch job because the
 * platform does not refresh the `videolist` flag.
 */
export function zhsCompletedVideos(detail: ZhsCourseDetail): number {
  if (typeof detail.completedVideos === "number") return detail.completedVideos;
  return detail.chapters.reduce(
    (total, chapter) =>
      total +
      chapter.lessons.reduce(
        (sum, lesson) =>
          sum +
          zhsLessonVideos(lesson).filter((video) => (video.isStudied ?? 0) !== 0)
            .length,
        0,
      ),
    0,
  );
}

/** Chinese label for a backend watch state. */
export function zhsWatchStateText(state: ZhsWatchState): string {
  switch (state) {
    case "ok":
      return "已完成（平台记录）";
    case "skip":
      return "跳过（已完成）";
    case "dry_run":
      return "已计划";
    case "failed":
      return "失败";
    case "cancelled":
      return "已取消";
    case "circuit_broken":
      return "已熔断";
  }
}
