import type { ItemDetail } from '../../lib/api';

export interface ItemProps {
  item: ItemDetail;
  /** gọi khi mục vừa hoàn thành (xp có thể 0) */
  onCompleted: (xp?: number) => void;
  /** mở mục tiếp theo trong bài (null nếu là mục cuối) */
  goNext: (() => void) | null;
}
