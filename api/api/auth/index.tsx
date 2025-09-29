/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

import React, { useState, useEffect, useRef, useMemo, useContext, createContext } from 'react';
import ReactDOM from 'react-dom/client';
// Fix: Add GenerateContentResponse to import to correctly type the API response.
import { GoogleGenAI, GenerateContentResponse } from "@google/genai";

declare var feather: any;
declare var Chart: any;
declare var marked: any;


// --- HELPERS ---
const formatDate = (isoString) => new Date(isoString).toLocaleString();
const daysAgo = (days) => {
    const date = new Date();
    date.setDate(date.getDate() - days);
    return date.toISOString();
};
const formatNaira = (amount) => {
    if (typeof amount !== 'number') return `₦0.00`;
    return `₦${amount.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

// --- AUTHENTICATION SYSTEM ---
const AuthContext = createContext(null);

const USER_ROLES = {
    ADMIN: 'admin',
    SALES_REP: 'sales_rep'
};

const PERMISSIONS = {
    // Product & Inventory Management
    VIEW_INVENTORY: 'view_inventory',
    ADD_PRODUCT: 'add_product',
    EDIT_PRODUCT: 'edit_product',
    DELETE_PRODUCT: 'delete_product',
    MANAGE_STOCK: 'manage_stock',
    
    // Sales & Customer Management
    VIEW_CUSTOMERS: 'view_customers',
    ADD_CUSTOMER: 'add_customer',
    EDIT_CUSTOMER: 'edit_customer',
    RECORD_SALE: 'record_sale',
    VIEW_SALES: 'view_sales',
    
    // Financial & Reports
    VIEW_FINANCIALS: 'view_financials',
    VIEW_REPORTS: 'view_reports',
    EXPORT_DATA: 'export_data',
    
    // User Management
    MANAGE_USERS: 'manage_users',
    VIEW_USER_ACTIVITY: 'view_user_activity',
    
    // Advanced Features
    MANAGE_SUPPLIERS: 'manage_suppliers',
    MANAGE_TECHNICIANS: 'manage_technicians',
    MANAGE_SERVICES: 'manage_services'
};

const ROLE_PERMISSIONS = {
    [USER_ROLES.ADMIN]: [
        // Full access to everything
        PERMISSIONS.VIEW_INVENTORY,
        PERMISSIONS.ADD_PRODUCT,
        PERMISSIONS.EDIT_PRODUCT,
        PERMISSIONS.DELETE_PRODUCT,
        PERMISSIONS.MANAGE_STOCK,
        PERMISSIONS.VIEW_CUSTOMERS,
        PERMISSIONS.ADD_CUSTOMER,
        PERMISSIONS.EDIT_CUSTOMER,
        PERMISSIONS.RECORD_SALE,
        PERMISSIONS.VIEW_SALES,
        PERMISSIONS.VIEW_FINANCIALS,
        PERMISSIONS.VIEW_REPORTS,
        PERMISSIONS.EXPORT_DATA,
        PERMISSIONS.MANAGE_USERS,
        PERMISSIONS.VIEW_USER_ACTIVITY,
        PERMISSIONS.MANAGE_SUPPLIERS,
        PERMISSIONS.MANAGE_TECHNICIANS,
        PERMISSIONS.MANAGE_SERVICES
    ],
    [USER_ROLES.SALES_REP]: [
        // Limited access focused on sales activities
        PERMISSIONS.VIEW_INVENTORY,
        PERMISSIONS.VIEW_CUSTOMERS,
        PERMISSIONS.ADD_CUSTOMER,
        PERMISSIONS.EDIT_CUSTOMER,
        PERMISSIONS.RECORD_SALE,
        PERMISSIONS.VIEW_SALES
    ]
};
