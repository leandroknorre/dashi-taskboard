import type { ActorIdentity, Task, TaskDraft } from "../types";
import type { TaskCardPresentation, TaskConversationItem } from "../taskConversations";
import { useTaskboardI18n } from "../i18n";
import { TaskCard } from "./TaskCard";

/**
 * `eisenhower:<slug>` labels are written by a separate classification pass
 * (not this view). A card with none of the four labels sits in no quadrant
 * this round, rather than inventing a fifth "unclassified" bucket.
 */
const QUADRANTS = [
  { slug: "urgente-importante", label: "Urgente + Importante" },
  { slug: "importante-nao-urgente", label: "Importante, não urgente" },
  { slug: "urgente-nao-importante", label: "Urgente, não importante" },
  { slug: "nem-urgente-nem-importante", label: "Nem urgente nem importante" },
] as const;

function eisenhowerLabel(slug: string) {
  return `eisenhower:${slug}`;
}

interface EisenhowerMatrixProps {
  tasks: Task[];
  presentations: Record<string, TaskCardPresentation>;
  now: number;
  availableLabels: string[];
  currentUser: ActorIdentity;
  showCover: boolean;
  showBody: boolean;
  contextMenuTaskId: string | null;
  onCreateLabel: (label: string) => Promise<void>;
  onEdit: (task: Task) => void;
  onUpdate: (task: Task, changes: Partial<TaskDraft>) => Promise<Task>;
  onComplete: (task: Task) => void;
  onContextMenu: (task: Task, position: { x: number; y: number }) => void;
  onOpenConversation: (conversation: TaskConversationItem) => void;
}

export function EisenhowerMatrix({
  tasks,
  presentations,
  now,
  availableLabels,
  currentUser,
  showCover,
  showBody,
  contextMenuTaskId,
  onCreateLabel,
  onEdit,
  onUpdate,
  onComplete,
  onContextMenu,
  onOpenConversation,
}: EisenhowerMatrixProps) {
  const { text } = useTaskboardI18n();
  return (
    <div className="eisenhower-matrix">
      {QUADRANTS.map((quadrant) => {
        const label = eisenhowerLabel(quadrant.slug);
        const quadrantTasks = tasks.filter((task) => task.labels.includes(label));
        return (
          <section className={`eisenhower-quadrant eisenhower-quadrant-${quadrant.slug}`} key={quadrant.slug}>
            <header>
              <h3>{quadrant.label}</h3>
              <span className="eisenhower-quadrant-count">{quadrantTasks.length}</span>
            </header>
            <div className="eisenhower-quadrant-cards">
              {quadrantTasks.length === 0 ? (
                <p className="eisenhower-quadrant-empty">{text("暂无议题", "No issues")}</p>
              ) : quadrantTasks.map((task) => (
                <TaskCard
                  key={task.id}
                  task={task}
                  presentation={presentations[task.id]}
                  now={now}
                  isDragging={false}
                  dragShift={0}
                  isMoving={false}
                  isSettling={false}
                  isContextMenuOpen={contextMenuTaskId === task.id}
                  availableLabels={availableLabels}
                  currentUser={currentUser}
                  showCover={showCover}
                  showBody={showBody}
                  onCreateLabel={onCreateLabel}
                  onEdit={onEdit}
                  onUpdate={onUpdate}
                  onComplete={onComplete}
                  onContextMenu={onContextMenu}
                  onDragStart={() => {}}
                  onDragEnd={() => {}}
                  onOpenConversation={onOpenConversation}
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
