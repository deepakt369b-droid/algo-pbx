"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import {
  AppBar,
  Box,
  Drawer,
  IconButton,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  ListSubheader,
  Toolbar,
  Typography,
} from "@mui/material";
import MenuIcon from "@mui/icons-material/Menu";
import DashboardIcon from "@mui/icons-material/Dashboard";
import GroupsIcon from "@mui/icons-material/Groups";
import ListAltIcon from "@mui/icons-material/ListAlt";
import DialpadIcon from "@mui/icons-material/Dialpad";
import GraphicEqIcon from "@mui/icons-material/GraphicEq";
import BarChartIcon from "@mui/icons-material/BarChart";
import WhatsAppIcon from "@mui/icons-material/WhatsApp";
import SmsIcon from "@mui/icons-material/Sms";
import MeetingRoomIcon from "@mui/icons-material/MeetingRoom";
import PeopleIcon from "@mui/icons-material/People";
import RouterIcon from "@mui/icons-material/Router";
import SettingsIcon from "@mui/icons-material/Settings";
import MonitorHeartIcon from "@mui/icons-material/MonitorHeart";
import LoginIcon from "@mui/icons-material/Login";
import BlockIcon from "@mui/icons-material/Block";
import SupportAgentIcon from "@mui/icons-material/SupportAgent";
import FactCheckIcon from "@mui/icons-material/FactCheck";
import LanguageIcon from "@mui/icons-material/Language";
import ContactsIcon from "@mui/icons-material/Contacts";
import { HealthPill } from "./health-pill";
import { ThemeToggleButton } from "./theme-toggle-button";

const DRAWER_WIDTH = 260;

interface NavItem {
  href: string;
  label: string;
  icon: React.ReactNode;
}
interface NavGroup {
  label: string;
  items: NavItem[];
}

const NAV_GROUPS: NavGroup[] = [
  {
    label: "Operations",
    items: [
      { href: "/admin", label: "Wallboard", icon: <DashboardIcon fontSize="small" /> },
      { href: "/admin/queues", label: "Queues", icon: <ListAltIcon fontSize="small" /> },
      { href: "/admin/cdr", label: "CDR", icon: <DialpadIcon fontSize="small" /> },
      { href: "/admin/recordings", label: "Recordings", icon: <GraphicEqIcon fontSize="small" /> },
      { href: "/admin/reports", label: "Reports", icon: <BarChartIcon fontSize="small" /> },
    ],
  },
  {
    label: "Messaging",
    items: [
      { href: "/admin/whatsapp", label: "WhatsApp", icon: <WhatsAppIcon fontSize="small" /> },
      { href: "/admin/sms", label: "SIM SMS", icon: <SmsIcon fontSize="small" /> },
      { href: "/admin/rooms", label: "Rooms", icon: <MeetingRoomIcon fontSize="small" /> },
      { href: "/admin/contacts", label: "Contacts", icon: <ContactsIcon fontSize="small" /> },
    ],
  },
  {
    label: "Configuration",
    items: [
      { href: "/admin/extensions", label: "Extensions", icon: <RouterIcon fontSize="small" /> },
      { href: "/admin/users", label: "Users", icon: <PeopleIcon fontSize="small" /> },
      { href: "/admin/escalations", label: "Manager Escalation", icon: <SupportAgentIcon fontSize="small" /> },
      { href: "/admin/dinstar", label: "Dinstar Gateway", icon: <RouterIcon fontSize="small" /> },
      { href: "/admin/domain", label: "Connect Domain", icon: <LanguageIcon fontSize="small" /> },
      { href: "/admin/settings", label: "Settings", icon: <SettingsIcon fontSize="small" /> },
      { href: "/admin/system", label: "System", icon: <MonitorHeartIcon fontSize="small" /> },
    ],
  },
  {
    label: "Audit",
    items: [
      { href: "/admin/sign-ins", label: "Sign-Ins", icon: <LoginIcon fontSize="small" /> },
      { href: "/admin/dnc", label: "Do Not Call", icon: <BlockIcon fontSize="small" /> },
      { href: "/admin/audit", label: "Audit Log", icon: <FactCheckIcon fontSize="small" /> },
    ],
  },
];

function NavList({ pathname, onNavigate }: { pathname: string; onNavigate?: () => void }) {
  return (
    <Box sx={{ overflowY: "auto" }}>
      {NAV_GROUPS.map((group) => (
        <List
          key={group.label}
          dense
          subheader={
            <ListSubheader component="div" sx={{ bgcolor: "transparent", lineHeight: 2, fontSize: "0.6875rem", letterSpacing: 0.6, fontWeight: 700 }}>
              {group.label}
            </ListSubheader>
          }
        >
          {group.items.map((item) => {
            const active = item.href === "/admin" ? pathname === "/admin" : pathname.startsWith(item.href);
            return (
              <ListItemButton
                key={item.href}
                component={Link}
                href={item.href}
                selected={active}
                onClick={onNavigate}
                sx={{ borderRadius: 2, mx: 1, mb: 0.25 }}
              >
                <ListItemIcon sx={{ minWidth: 36, color: active ? "primary.main" : "text.secondary" }}>{item.icon}</ListItemIcon>
                <ListItemText slotProps={{ primary: { sx: { fontSize: "0.875rem", fontWeight: active ? 600 : 500 } } }}>{item.label}</ListItemText>
              </ListItemButton>
            );
          })}
        </List>
      ))}
    </Box>
  );
}

export function AdminShell({
  children,
  userEmail,
  signOutAction,
}: {
  children: React.ReactNode;
  userEmail?: string | null;
  signOutAction: () => Promise<void>;
}) {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <Box sx={{ display: "flex", minHeight: "100vh" }}>
      <AppBar
        position="fixed"
        color="inherit"
        elevation={0}
        sx={{ zIndex: (t) => t.zIndex.drawer + 1, borderBottom: 1, borderColor: "divider", backdropFilter: "blur(8px)" }}
      >
        <Toolbar sx={{ gap: 2 }}>
          <IconButton edge="start" sx={{ display: { sm: "none" } }} onClick={() => setMobileOpen(true)}>
            <MenuIcon />
          </IconButton>
          <Typography variant="h6" sx={{ fontWeight: 700, fontSize: "1.05rem" }}>
            Algo PBX
          </Typography>
          <Box sx={{ flexGrow: 1 }} />
          <HealthPill />
          <ThemeToggleButton />
          <Typography variant="body2" color="text.secondary" sx={{ display: { xs: "none", sm: "block" } }}>
            {userEmail}
          </Typography>
          <form action={signOutAction}>
            <IconButton type="submit" size="small" title="Sign out">
              <LoginIcon fontSize="small" sx={{ transform: "rotate(180deg)" }} />
            </IconButton>
          </form>
        </Toolbar>
      </AppBar>

      <Drawer
        variant="permanent"
        sx={{
          display: { xs: "none", sm: "block" },
          width: DRAWER_WIDTH,
          flexShrink: 0,
          [`& .MuiDrawer-paper`]: { width: DRAWER_WIDTH, boxSizing: "border-box", borderRight: 1, borderColor: "divider" },
        }}
      >
        <Toolbar />
        <NavList pathname={pathname} />
      </Drawer>
      <Drawer
        variant="temporary"
        open={mobileOpen}
        onClose={() => setMobileOpen(false)}
        ModalProps={{ keepMounted: true }}
        sx={{ display: { xs: "block", sm: "none" }, [`& .MuiDrawer-paper`]: { width: DRAWER_WIDTH } }}
      >
        <Toolbar />
        <NavList pathname={pathname} onNavigate={() => setMobileOpen(false)} />
      </Drawer>

      <Box component="main" sx={{ flexGrow: 1, p: { xs: 2, sm: 4 }, width: { sm: `calc(100% - ${DRAWER_WIDTH}px)` } }}>
        <Toolbar />
        {children}
      </Box>
    </Box>
  );
}
