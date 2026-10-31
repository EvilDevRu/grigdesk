import { createRouter, createWebHashHistory } from 'vue-router';

import AddRelayView from './views/AddRelayView.vue';
import RelaysView from './views/RelaysView.vue';
import ChatsView from './views/ChatsView.vue';
import ChatView from './views/ChatView.vue';
import TasksView from './views/TasksView.vue';
import TaskView from './views/TaskView.vue';
import TrackerView from './views/TrackerView.vue';
import TrackerTaskView from './views/TrackerTaskView.vue';
import MoreView from './views/MoreView.vue';

// Карточки вложены в свои списки: страница списка остаётся смонтированной, поэтому на
// планшете они стоят рядом, а на телефоне возврат к списку не теряет его прокрутку.
export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    {
      path: '/',
      redirect: '/chats',
    },
    {
      path: '/relays',
      component: RelaysView,
    },
    {
      path: '/relays/add',
      component: AddRelayView,
    },
    {
      path: '/chats',
      component: ChatsView,
      children: [
        {
          path: ':id',
          component: ChatView,
        },
      ],
    },
    {
      path: '/tasks',
      component: TasksView,
      children: [
        {
          path: ':id',
          component: TaskView,
        },
      ],
    },
    {
      path: '/tracker',
      component: TrackerView,
      children: [
        {
          path: ':id',
          component: TrackerTaskView,
        },
      ],
    },
    {
      path: '/more',
      component: MoreView,
    },
    {
      path: '/:pathMatch(.*)*',
      redirect: '/chats',
    },
  ],
});
