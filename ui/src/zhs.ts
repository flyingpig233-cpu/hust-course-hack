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

/** Total number of playable videos in a course tree. */
export function zhsTotalVideos(detail: ZhsCourseDetail): number {
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

/** Number of videos the platform currently marks as studied. */
export function zhsCompletedVideos(detail: ZhsCourseDetail): number {
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
      return "已完成";
    case "skip":
      return "已跳过";
    case "dry_run":
      return "预演";
    case "failed":
      return "失败";
    case "cancelled":
      return "已取消";
    case "circuit_broken":
      return "已熔断";
  }
}
